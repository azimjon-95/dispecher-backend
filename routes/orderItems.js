const router     = require('express').Router()
const { OrderItem, Employee, Salary } = require('../models')

const ETAP_NEXT = {
  qabul:       'yuvish',
  yuvish:      'quritish',
  quritish:    'bezak',
  bezak:       'yetkazish',
  yetkazish:   'tugallandi',
  tugallandi:  'tugallandi',
}

const ETAP_LABEL = {
  qabul:      'Qabul qilindi',
  yuvish:     'Yuvish bo\'limi',
  quritish:   'Quritish bo\'limi',
  bezak:      'Bezak bo\'limi',
  yetkazish:  'Yetkazish bo\'limi',
  tugallandi: 'Tugallandi',
}

/* ── GET /api/order-items?orderId=xxx ── */
router.get('/', async (req, res) => {
  try {
    const q = { deletedAt: { $exists: false } }
    if (req.query.orderId) q.orderId = req.query.orderId
    if (req.query.stage)   q.stage   = req.query.stage
    const items = await OrderItem.find(q).sort({ createdAt: -1 })
    res.json(items)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/* ── POST /api/order-items ── */
router.post('/', async (req, res) => {
  try {
    const body = { ...req.body }
    // Auto-calc sqm and totalPrice
    if (body.unit === 'sqm' && body.width && body.length) {
      body.sqm        = Math.round(parseFloat(body.width) * parseFloat(body.length) * 100) / 100
      body.totalPrice = Math.round(body.sqm * (body.pricePerUnit || 0))
    } else {
      body.totalPrice = Math.round((body.qty || 1) * (body.pricePerUnit || 0))
    }
    const item = await OrderItem.create(body)
    res.status(201).json(item)
  } catch (e) { res.status(400).json({ error: e.message }) }
})

/* ── PUT /api/order-items/:id ── */
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
    res.json(item)
  } catch (e) { res.status(400).json({ error: e.message }) }
})

/* ── DELETE /api/order-items/:id (soft) ── */
router.delete('/:id', async (req, res) => {
  try {
    await OrderItem.findByIdAndUpdate(req.params.id, { deletedAt: new Date() })
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/* ── POST /api/order-items/:id/assign  — ishchiga biriktirish ── */
router.post('/:id/assign', async (req, res) => {
  try {
    const { workerId, stage } = req.body
    if (!workerId) return res.status(400).json({ error: 'workerId kerak' })

    const item   = await OrderItem.findById(req.params.id)
    if (!item) return res.status(404).json({ error: 'Mahsulot topilmadi' })

    const worker = await Employee.findById(workerId)
    if (!worker) return res.status(404).json({ error: 'Ishchi topilmadi' })

    const assignStage = stage || item.stage

    // Remove old assignment for this stage, add new
    item.assignments = item.assignments.filter(a => a.stage !== assignStage)
    item.assignments.push({
      stage:       assignStage,
      workerId:    worker._id,
      workerName:  worker.name,
      workerPhone: worker.phone,
      assignedAt:  new Date(),
    })

    // Move to next stage
    item.stage = ETAP_NEXT[assignStage] || assignStage
    item.tgNotified = false
    await item.save()

    res.json({ item, worker: { name: worker.name, phone: worker.phone }, message: `${worker.name} ga biriktirildi` })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/* ── POST /api/order-items/:id/advance  — keyingi etapga o'tkazish ── */
router.post('/:id/advance', async (req, res) => {
  try {
    const item = await OrderItem.findById(req.params.id)
    if (!item) return res.status(404).json({ error: 'Topilmadi' })

    const nextStage = ETAP_NEXT[item.stage]
    if (!nextStage || nextStage === item.stage) {
      return res.status(400).json({ error: 'Oxirgi etapda' })
    }

    // Mark current stage done
    const curAssign = item.assignments.find(a => a.stage === item.stage && !a.doneAt)
    if (curAssign) curAssign.doneAt = new Date()

    item.stage = nextStage
    await item.save()

    // Update worker balance (earned) if stage was yuvish/quritish/bezak
    const earnStages = ['yuvish', 'quritish', 'bezak']
    if (earnStages.includes(item.stage === 'tugallandi' ? item.stage : item.stage) && curAssign) {
      const earn = item.unit === 'sqm'
        ? Math.round((item.sqm || 0) * 1500)   // 1 kv.m uchun 1500 so'm default
        : Math.round((item.qty || 1) * 2000)
      await Employee.findByIdAndUpdate(curAssign.workerId, { $inc: { balance: earn } })
    }

    res.json({ item, nextStage, label: ETAP_LABEL[nextStage] })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/* ── GET /api/order-items/by-stage/:stage ── */
router.get('/by-stage/:stage', async (req, res) => {
  try {
    const items = await OrderItem.find({
      stage: req.params.stage,
      deletedAt: { $exists: false }
    }).sort({ createdAt: -1 }).limit(100)
    res.json(items)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

module.exports = router
