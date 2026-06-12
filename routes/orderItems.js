'use strict'
const router       = require('express').Router()
const cache = require('../redis/cache')
const { cacheGet, invalidateCache, invalidatePrefix } = require('../redis/cacheMiddleware')
const { OrderItem, Order, Employee, Finance, Task } = require('../models')

/* ── Stage map ── */
const ETAP_NEXT = {
  qabul:      'yuvish',
  yuvish:     'quritish',
  quritish:   'bezak',
  bezak:      'yetkazish',
  yetkazish:  'tugallandi',
  tugallandi: 'tugallandi',
}
const ETAP_LABEL = {
  qabul:'Qabul', yuvish:'Yuvish', quritish:'Quritish',
  bezak:'Bezak', yetkazish:'Yetkazish', tugallandi:'Tugallandi',
}
// Ishchi pul oladigan bosqichlar va mezonlar
const EARN_RATES = {
  yuvish:   { sqm: 1500, dona: 2000 },
  quritish: { sqm:  800, dona: 1000 },
  bezak:    { sqm: 1000, dona: 1500 },
}

/* ─── Helper: order total va status update ─── */
async function syncOrderStats(orderId) {
  try {
    const items = await OrderItem.find({ orderId, deletedAt:{ $exists:false } })
    if (!items.length) return

    const total     = items.reduce((s,i) => s + (i.totalPrice||0), 0)
    const itemCount = items.length

    // Dominant stage
    const stagePriority = ['yetkazish','bezak','quritish','yuvish','qabul','tugallandi']
    const stages = items.map(i=>i.stage)
    let dominant = 'qabul'
    for (const sp of stagePriority) {
      if (stages.includes(sp)) { dominant = sp; break }
    }

    // Order status map
    const stageToOrder = {
      qabul:      'qabul_qilindi',
      yuvish:     'yuvishda',
      quritish:   'qurishda',
      bezak:      'bezakda',
      yetkazish:  'yetkazishda',
      tugallandi: 'tugallandi',
    }

    const allDone = items.every(i => i.stage === 'tugallandi')
    const newStatus = allDone ? 'tugallandi' : (stageToOrder[dominant] || 'qabul_qilindi')

    // Build item summary "2 ta Gilam, 1 ta Ko'rpa"
    const typeCounts = {}
    items.forEach(i => {
      const name = i.name || i.itemType || 'Mahsulot'
      typeCounts[name] = (typeCounts[name] || 0) + 1
    })
    const itemSummary = Object.entries(typeCounts)
      .map(([n,cnt]) => `${cnt} ta ${n}`)
      .join(', ')

    await Order.findByIdAndUpdate(orderId, {
      $set: { total, itemCount, status: newStatus, itemSummary }
    })

    // If bezak done → auto create delivery task
    if (dominant === 'yetkazish') {
      const order = await Order.findById(orderId)
      if (order) {
        const existsDelivery = await Task.findOne({ orderId, type:'delivery', deletedAt:{ $exists:false } })
        if (!existsDelivery) {
          await Task.create({
            order:    order.number,
            orderId:  order._id,
            customer: order.customer,
            phone:    order.phone,
            address:  order.address,
            lat:      order.lat,
            lon:      order.lon,
            type:     'delivery',
            status:   'yangi',
            date:     new Date().toISOString().slice(0,10),
            totalPrice: total,
            amountDue:  total,
            paid:       false,
          })
        }
      }
    }

    return newStatus
  } catch(e) { console.error('syncOrderStats:', e.message) }
}

/* ─── GET /api/order-items?orderId=xxx ─── */
router.get('/', cacheGet(), async (req, res) => {
  try {
    const q = { deletedAt: { $exists: false } }
    if (req.query.orderId) q.orderId = req.query.orderId
    if (req.query.stage)   q.stage   = { $in: req.query.stage.split(',') }
    const items = await OrderItem.find(q).sort({ createdAt: 1 })
    res.json(items)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

/* ─── POST /api/order-items ─── */
router.post('/', async (req, res) => {
  try {
    const body = { ...req.body }
    if (body.unit === 'sqm' && body.width && body.length) {
      body.sqm        = Math.round(parseFloat(body.width) * parseFloat(body.length) * 100) / 100
      body.totalPrice = Math.round(body.sqm * (body.pricePerUnit || 0))
    } else {
      body.totalPrice = Math.round((body.qty || 1) * (body.pricePerUnit || 0))
    }
    body.stage = 'qabul'
    const item = await OrderItem.create(body)
    await syncOrderStats(body.orderId)
    res.status(201).json(item)
  } catch(e) { res.status(400).json({ error: e.message }) }
})

/* ─── PUT /api/order-items/:id ─── */
router.put('/:id', async (req, res) => {
  try {
    const body = { ...req.body }
    if (body.unit === 'sqm' && body.width && body.length) {
      body.sqm        = Math.round(parseFloat(body.width) * parseFloat(body.length) * 100) / 100
      body.totalPrice = Math.round(body.sqm * (body.pricePerUnit || 0))
    } else if (body.qty && body.pricePerUnit) {
      body.totalPrice = Math.round((body.qty || 1) * (body.pricePerUnit || 0))
    }
    const item = await OrderItem.findByIdAndUpdate(req.params.id, { $set: body }, { new: true })
    if (!item) return res.status(404).json({ error: 'Topilmadi' })
    await syncOrderStats(item.orderId)
    res.json(item)
  } catch(e) { res.status(400).json({ error: e.message }) }
})

/* ─── DELETE /api/order-items/:id ─── */
router.delete('/:id', async (req, res) => {
  try {
    const item = await OrderItem.findByIdAndUpdate(req.params.id, { deletedAt: new Date() }, { new: true })
    if (item) await syncOrderStats(item.orderId)
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

/* ─── POST /api/order-items/:id/assign ─── */
// FAQAT ishchi biriktiriladi, stage O'ZGARMAYDI
router.post('/:id/assign', async (req, res) => {
  try {
    const { workerId, stage } = req.body
    if (!workerId) return res.status(400).json({ error: 'workerId kerak' })

    const item   = await OrderItem.findById(req.params.id)
    if (!item)   return res.status(404).json({ error: 'Mahsulot topilmadi' })

    const worker = await Employee.findById(workerId)
    if (!worker) return res.status(404).json({ error: 'Ishchi topilmadi' })

    const assignStage = stage || item.stage

    // Oldingi biriktirishni yangilaymiz (replace)
    item.assignments = item.assignments.filter(a => a.stage !== assignStage)
    item.assignments.push({
      stage:       assignStage,
      workerId:    worker._id,
      workerName:  worker.name,
      workerPhone: worker.phone,
      assignedAt:  new Date(),
      doneAt:      null,
    })

    // Stage O'ZGARMAYDI — ishchi biriktirildi xalos
    await item.save()

    res.json({
      item,
      worker: { name: worker.name, phone: worker.phone },
      message: `${worker.name} → ${ETAP_LABEL[assignStage]} bosqichiga biriktirildi`,
    })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

/* ─── POST /api/order-items/:id/advance ─── */
// Ishchi bosqichni tugalladi → keyingiga o'tadi + balansga yoziladi
router.post('/:id/advance', async (req, res) => {
  try {
    const item = await OrderItem.findById(req.params.id)
    if (!item) return res.status(404).json({ error: 'Topilmadi' })

    const currStage = item.stage
    const nextStage = ETAP_NEXT[currStage]
    if (!nextStage || nextStage === currStage) {
      return res.status(400).json({ error: 'Oxirgi bosqichda' })
    }

    // Hozirgi bosqich tugallandi deb belgilash
    const curAssign = item.assignments.find(a => a.stage === currStage && !a.doneAt)
    if (curAssign) curAssign.doneAt = new Date()

    item.stage = nextStage
    await item.save()

    // Ishchi balansiga qo'shish (agar earn bosqichi bo'lsa)
    const rates = EARN_RATES[currStage]
    if (rates && curAssign?.workerId) {
      const earn = item.unit === 'sqm'
        ? Math.round((item.sqm || 0) * rates.sqm)
        : Math.round((item.qty || 1) * rates.dona)

      if (earn > 0) {
        await Employee.findByIdAndUpdate(curAssign.workerId, { $inc: { balance: earn } })
        // Salary record
        await require('../models').Salary.create({
          employee:   curAssign.workerName,
          employeeId: curAssign.workerId,
          orderId:    item.orderId,
          orderItem:  item.name,
          stage:      currStage,
          amount:     earn,
          date:       new Date().toISOString().slice(0,10),
          note:       `${item.name} — ${ETAP_LABEL[currStage]}`,
        }).catch(()=>{})
      }
    }

    // Order stats sync (avtomatik delivery task yaratish ham shu yerda)
    const newOrderStatus = await syncOrderStats(item.orderId)

    res.json({
      item,
      nextStage,
      label:    ETAP_LABEL[nextStage],
      earned:   rates && curAssign ? (item.unit==='sqm' ? Math.round((item.sqm||0)*rates.sqm) : Math.round((item.qty||1)*rates.dona)) : 0,
      orderStatus: newOrderStatus,
    })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

/* ─── GET /api/order-items/by-stage/:stage ─── */
router.get('/by-stage/:stage', async (req, res) => {
  try {
    const items = await OrderItem.find({ stage: req.params.stage, deletedAt:{ $exists:false } }).sort({ createdAt: -1 }).limit(100)
    res.json(items)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

module.exports = router
