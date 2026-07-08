// =============================================
//  BOT API ROUTES  — Admin panel → Bot trigger
// =============================================
const router  = require('express').Router()
const tg      = require('../services/telegram')
const cache   = require('../redis/cache')
const {
  Task, Driver, Employee, OrderItem, Order, Finance, Customer
} = require('../models')

const fc = n => (n || 0).toLocaleString('ru-RU') + " so'm"

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   POST /api/bot/send-pickup
//   Transport sahifasidan shafyorga pickup xabari
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/send-pickup', async (req, res) => {
  try {
    const { taskId } = req.body
    const task = await Task.findById(taskId)
    if (!task) return res.status(404).json({ error: 'Task topilmadi' })

    const driver = await Driver.findOne({ name: task.driver })
    if (!driver?.tgChatId) {
      return res.status(400).json({ error: 'Shafyorning Telegram chatId si yo\'q. Avval ro\'yxatdan o\'tsin.' })
    }

    // Get order items
    const items = task.orderId
      ? await OrderItem.find({ orderId: task.orderId, deletedAt: { $exists: false } })
      : []

    const ok = await tg.sendPickupToDriver(driver.tgChatId, {
      taskId:   task._id.toString(),
      order:    task.order,
      customer: task.customer,
      phone:    task.phone,
      address:  task.address,
      lat:      task.lat,
      lon:      task.lon,
      items:    items.map(i => ({
        name:  i.name,
        unit:  i.unit,
        sqm:   i.sqm,
        qty:   i.qty,
        itemCode: i._id.toString().slice(-6).toUpperCase()
      }))
    })

    if (!ok) return res.status(500).json({ error: 'TG xabar yuborishda xato' })

    await Task.findByIdAndUpdate(taskId, { tgSent: true })
    res.json({ ok: true, message: `${driver.name} ga xabar yuborildi` })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   POST /api/bot/send-delivery
//   Yetkazib berish xabari
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/send-delivery', async (req, res) => {
  try {
    const { taskId } = req.body
    const task = await Task.findById(taskId)
    if (!task) return res.status(404).json({ error: 'Task topilmadi' })

    const driver = await Driver.findOne({ name: task.driver })
    if (!driver?.tgChatId) {
      return res.status(400).json({ error: "Shafyorning Telegram chatId si yo'q" })
    }

    // Order & items
    const order = task.orderId ? await Order.findById(task.orderId) : null
    const items = task.orderId
      ? await OrderItem.find({ orderId: task.orderId, deletedAt: { $exists: false } })
      : []

    const totalPrice = order?.total || task.totalPrice || 0
    const paid       = task.paid || false
    const amountDue  = paid ? 0 : totalPrice

    const ok = await tg.sendDeliveryToDriver(driver.tgChatId, {
      taskId:     task._id.toString(),
      order:      task.order,
      customer:   task.customer,
      phone:      task.phone,
      address:    task.address,
      lat:        task.lat,
      lon:        task.lon,
      totalPrice,
      paid,
      amountDue,
      items: items.map(i => ({
        name:     i.name,
        unit:     i.unit,
        sqm:      i.sqm,
        qty:      i.qty,
        itemCode: i._id.toString().slice(-6).toUpperCase()
      }))
    })

    // Save amountDue to task for later
    await Task.findByIdAndUpdate(taskId, { totalPrice, amountDue, tgSent: true })

    if (!ok) return res.status(500).json({ error: 'TG xabar yuborishda xato' })
    res.json({ ok: true, message: `${driver.name} ga delivery xabari yuborildi` })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   POST /api/bot/send-item-to-worker
//   Ishchiga mahsulot biriktirish
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/send-item', async (req, res) => {
  try {
    const { itemId, workerId } = req.body
    const item   = await OrderItem.findById(itemId)
    const worker = await Employee.findById(workerId)

    if (!item)   return res.status(404).json({ error: 'Mahsulot topilmadi' })
    if (!worker) return res.status(404).json({ error: 'Ishchi topilmadi' })
    if (!worker.tgChatId) {
      return res.status(400).json({ error: "Ishchining Telegram chatId si yo'q" })
    }

    const ok = await tg.sendItemToWorker(worker.tgChatId, {
      _id:         item._id.toString(),
      itemCode:    item._id.toString().slice(-6).toUpperCase(),
      orderNumber: item.orderNumber,
      name:        item.name,
      unit:        item.unit,
      sqm:         item.sqm,
      qty:         item.qty,
      width:       item.width,
      length:      item.length,
      stage:       item.stage,
    })

    await OrderItem.findByIdAndUpdate(itemId, { tgNotified: true })

    if (!ok) return res.status(500).json({ error: 'TG xabar yuborishda xato' })
    res.json({ ok: true, message: `${worker.name} ga xabar yuborildi` })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   GET /api/bot/driver-link/:driverId
//   Shafyor uchun ro'yxatdan o'tish havolasi
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/driver-link/:id', async (req, res) => {
  try {
    const driver = await Driver.findById(req.params.id)
    if (!driver) return res.status(404).json({ error: 'Topilmadi' })

    const phone = driver.phone.replace('+', '')
    const botUsername = process.env.BOT_USERNAME || 'DispecherBot'
    const link = `https://t.me/${botUsername}?start=driver_${phone}`

    res.json({
      link,
      driver: driver.name,
      phone:  driver.phone,
      registered: !!driver.tgChatId
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   GET /api/bot/worker-link/:workerId
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/worker-link/:id', async (req, res) => {
  try {
    const worker = await Employee.findById(req.params.id)
    if (!worker) return res.status(404).json({ error: 'Topilmadi' })

    const phone = worker.phone.replace('+', '')
    const botUsername = process.env.BOT_USERNAME || 'DispecherBot'
    const link = `https://t.me/${botUsername}?start=worker_${phone}`

    res.json({
      link,
      worker: worker.name,
      phone:  worker.phone,
      registered: !!worker.tgChatId
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   GET /api/bot/driver-stats/:driverId
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/driver-stats/:id', async (req, res) => {
  try {
    const driver = await Driver.findById(req.params.id)
    if (!driver) return res.status(404).json({ error: 'Topilmadi' })

    const now  = new Date()
    const from = new Date(now.getFullYear(), now.getMonth(), 1)

    const [total, thisMonth, cashEarned] = await Promise.all([
      Task.countDocuments({ driver: driver.name, status: 'yetkazildi' }),
      Task.countDocuments({ driver: driver.name, status: 'yetkazildi', createdAt: { $gte: from } }),
      Finance.aggregate([
        { $match: { by: driver.name, type: 'kirim' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ])
    ])

    res.json({
      name:       driver.name,
      totalTrips: total,
      thisMonth,
      cashEarned: cashEarned[0]?.total || 0,
      tgRegistered: !!driver.tgChatId
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   GET /api/bot/cache-status
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/cache-status', (req, res) => {
  res.json({ cacheType: cache.status() })
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   POST /api/bot/request-location
//   Mijozga Telegram orqali manzil so'rash
//
//   Mantiq:
//   1. orderId, phone bo'yicha Customer topiladi
//   2. tgChatId bor → customerBot to'g'ridan xabar yuboradi
//   3. tgChatId yo'q → deep link qaytariladi (admin yuboradi)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/request-location', async (req, res) => {
  try {
    const { orderId, phone, custId } = req.body
    if (!orderId) return res.status(400).json({ error: 'orderId kerak' })

    const CUSTOMER_BOT = process.env.CUSTOMER_BOT_USERNAME || 'tartibcrm_customer_bot'

    // Mijozni topamiz
    let customer = null
    if (custId) customer = await Customer.findById(custId).lean()
    if (!customer && phone) {
      const clean = phone.replace(/\D/g, '')
      customer = await Customer.findOne({
        phone: { $regex: clean.slice(-9) }
      }).lean()
    }

    const cId = customer?._id?.toString() || custId || ''
    const deepLink = `https://t.me/${CUSTOMER_BOT}?start=cust_loc_${orderId}_${cId}`

    // Telegram'da ro'yxatdan o'tgan bo'lsa — to'g'ridan xabar
    if (customer?.tgChatId && process.env.CUSTOMER_BOT_TOKEN) {
      try {
        const { sendLocationRequest } = require('../bot/customerBot')
        const sent = await sendLocationRequest(customer.tgChatId, orderId, cId)
        if (sent) {
          return res.json({
            sent:     true,
            method:   'telegram',
            tgChatId: customer.tgChatId,
            name:     customer.name,
            deepLink,
          })
        }
      } catch {}
    }

    // Telegram yo'q — deep link qaytaramiz (admin o'zi yubboradi)
    res.json({
      sent:     false,
      method:   'link',
      deepLink,
      name:     customer?.name || '',
      phone:    customer?.phone || phone || '',
      hasTg:    !!customer?.tgChatId,
    })

  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
