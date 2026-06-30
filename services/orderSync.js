'use strict'
/**
 * services/orderSync.js
 *
 * Buyurtmaning umumiy narxi, mahsulotlar soni va statusini
 * uning OrderItem'lari asosida qayta hisoblaydi.
 *
 * Bu funksiya HAR DOIM OrderItem o'zgarganda chaqirilishi shart —
 * route orqali bo'lsin (CRM dan), botdan bo'lsin (ishchi/shafyordan) farqi yo'q.
 * Shu sababli alohida servis sifatida ajratilgan: ikkalasi ham
 * bir xil mantiq, bir xil cache invalidation, bir xil real-time
 * broadcast ishlatadi — kod takrorlanmaydi, xato qilish ehtimoli kamayadi.
 */
const { Order, OrderItem, Task, Employee, Salary } = require('../models')
const { invalidatePrefix } = require('../redis/cacheMiddleware')
const { broadcast } = require('../routes/_broadcast')

const STAGE_TO_ORDER_STATUS = {
  qabul:      'qabul_qilindi',
  yuvish:     'yuvishda',
  quritish:   'qurishda',
  bezak:      'bezakda',
  yetkazish:  'yetkazishda',
  tugallandi: 'tugallandi',
}
const STAGE_PRIORITY = ['yetkazish','bezak','quritish','yuvish','qabul','tugallandi']

/* Bosqichlar ketma-ketligi va ishchi haqi stavkalari —
   route (CRM) va bot (Telegram) ikkalasi ham shu yerdan oladi,
   shunda ikki joyda raqamlar mos kelmasligi xavfi bo'lmaydi. */
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
const EARN_RATES = {
  yuvish:   { sqm: 1500, dona: 2000 },
  quritish: { sqm:  800, dona: 1000 },
  bezak:    { sqm: 1000, dona: 1500 },
}

/**
 * Buyurtma statistikasini qayta hisoblaydi, DB ga yozadi,
 * tegishli Redis cache larni tozalaydi va Socket.IO orqali
 * barcha adminlarga real-time xabar beradi.
 *
 * @param {string} orderId
 * @returns {Promise<string|undefined>} yangi order statusi
 */
async function syncOrderStats(orderId) {
  try {
    const items = await OrderItem.find({ orderId, deletedAt: { $exists: false } })
    if (!items.length) return

    const total     = items.reduce((s, i) => s + (i.totalPrice || 0), 0)
    const itemCount = items.length

    const stages = items.map(i => i.stage)
    let dominant = 'qabul'
    for (const sp of STAGE_PRIORITY) {
      if (stages.includes(sp)) { dominant = sp; break }
    }

    const allDone   = items.every(i => i.stage === 'tugallandi')
    const newStatus = allDone ? 'tugallandi' : (STAGE_TO_ORDER_STATUS[dominant] || 'qabul_qilindi')

    const typeCounts = {}
    items.forEach(i => {
      const name = i.name || i.itemType || 'Mahsulot'
      typeCounts[name] = (typeCounts[name] || 0) + 1
    })
    const itemSummary = Object.entries(typeCounts)
      .map(([n, cnt]) => `${cnt} ta ${n}`)
      .join(', ')

    await Order.findByIdAndUpdate(orderId, {
      $set: { total, itemCount, status: newStatus, itemSummary },
    })

    // Bezak tugagach — avtomatik yetkazib berish topshirig'i yaratiladi
    if (dominant === 'yetkazish') {
      const order = await Order.findById(orderId)
      if (order) {
        const existsDelivery = await Task.findOne({
          orderId, type: 'delivery', deletedAt: { $exists: false },
        })
        if (!existsDelivery) {
          await Task.create({
            order:      order.number,
            orderId:    order._id,
            customer:   order.customer,
            phone:      order.phone,
            address:    order.address,
            lat:        order.lat,
            lon:        order.lon,
            type:       'delivery',
            status:     'yangi',
            date:       new Date().toISOString().slice(0, 10),
            totalPrice: total,
            amountDue:  total,
            paid:       false,
          })
          await invalidatePrefix('delivery')
          broadcast('delivery')
        }
      }
    }

    // Order o'zgardi — cache tozalanadi, CRM darhol yangilanadi
    await invalidatePrefix('orders')
    await invalidatePrefix('order-items')
    await invalidatePrefix('dashboard')
    broadcast('orders')

    return newStatus
  } catch (e) {
    console.error('syncOrderStats xato:', e.message)
  }
}

module.exports = { syncOrderStats, advanceOrderItem, ETAP_NEXT, ETAP_LABEL, EARN_RATES }

/**
 * Bitta mahsulot (OrderItem) bosqichini bittasi keyingisiga o'tkazadi:
 * ishchi balansiga haq qo'shadi, Salary yozuvi yaratadi,
 * va syncOrderStats orqali buyurtmani, cache'ni va real-time
 * broadcast'ni avtomatik yangilaydi.
 *
 * Bu funksiya HTTP route'dan ham (CRM dan qo'lda), botdan ham
 * (ishchi Telegram'da tugma bossa) bir xil chaqiriladi — shu sabab
 * ikkala joyda alohida-alohida yozish o'rniga shu yerga jamlangan.
 *
 * @param {string} itemId — OrderItem._id
 * @returns {Promise<{item, nextStage, label, earned, orderStatus}>}
 */
async function advanceOrderItem(itemId) {
  const item = await OrderItem.findById(itemId)
  if (!item) throw Object.assign(new Error('Topilmadi'), { status: 404 })

  const currStage = item.stage
  const nextStage = ETAP_NEXT[currStage]
  if (!nextStage || nextStage === currStage) {
    throw Object.assign(new Error('Oxirgi bosqichda'), { status: 400 })
  }

  const curAssign = item.assignments.find(a => a.stage === currStage && !a.doneAt)
  if (curAssign) curAssign.doneAt = new Date()

  item.stage = nextStage
  await item.save()

  let earned = 0
  const rates = EARN_RATES[currStage]
  if (rates && curAssign?.workerId) {
    earned = item.unit === 'sqm'
      ? Math.round((item.sqm || 0) * rates.sqm)
      : Math.round((item.qty || 1) * rates.dona)

    if (earned > 0) {
      await Employee.findByIdAndUpdate(curAssign.workerId, { $inc: { balance: earned } })
      await Salary.create({
        employee:   curAssign.workerName,
        employeeId: curAssign.workerId,
        orderId:    item.orderId,
        orderItem:  item.name,
        stage:      currStage,
        amount:     earned,
        date:       new Date().toISOString().slice(0, 10),
        note:       `${item.name} — ${ETAP_LABEL[currStage]}`,
      }).catch(() => {})
      await invalidatePrefix('employees') // balans o'zgardi
    }
  }

  const orderStatus = await syncOrderStats(item.orderId)

  return { item, nextStage, label: ETAP_LABEL[nextStage], earned, orderStatus }
}
