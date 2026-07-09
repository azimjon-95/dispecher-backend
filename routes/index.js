const router = require('express').Router
const ctrl   = require('../controllers/crudCtrl')
const {
  Order, Task, Counter,
  Employee, Driver, Customer,
  Finance, Salary, Settings, Price,
} = require('../models')
const cache = require('../redis/cache')
const { cacheGet, invalidateCache, invalidatePrefix } = require('../redis/cacheMiddleware')
const { broadcast, withBroadcast } = require('./_broadcast')

/* ── Cache-aware CRUD builder — cache + real-time birga ── */
function buildCached(Model, fields, prefix, ttl) {
  const c = ctrl(Model, fields)
  const r = router()
  r.get('/',       cacheGet(ttl), c.getAll)
  r.get('/:id',    cacheGet(ttl*2), c.getOne)
  r.post('/',      invalidateCache([prefix,'dashboard']), withBroadcast(prefix), c.create)
  r.put('/:id',    invalidateCache([prefix,'dashboard']), withBroadcast(prefix), c.update)
  r.delete('/:id', invalidateCache([prefix,'dashboard']), withBroadcast(prefix), c.remove)
  return r
}

function build(Model, fields) {
  const c = ctrl(Model, fields)
  const r = router()
  r.get('/',       c.getAll)
  r.get('/:id',    c.getOne)
  r.post('/',      c.create)
  r.put('/:id',    c.update)
  r.delete('/:id', c.remove)
  return r
}
// NOTE: use buildCached() for new routes

/* Orders with auto-number */
const ordersR = router()
const oc = ctrl(Order, ['customer','phone','address','number'])
ordersR.get('/',    cacheGet(30), oc.getAll)
ordersR.get('/:id', cacheGet(60), oc.getOne)
ordersR.post('/', invalidateCache(['orders','dashboard']), async (req, res) => {
  try {
    // Atomic increment — ikkita dispatcher bir vaqtda buyurtma
    // yaratsa ham, har biri KAFOLATLANGAN noyob raqam oladi.
    // (Avval countDocuments() ishlatilardi — bu race condition
    // tufayli ikkita buyurtmaga bir xil raqam berib qo'yishi mumkin edi.)
    const counter = await Counter.findOneAndUpdate(
      { key: 'order_number' },
      { $inc: { value: 1 } },
      { upsert: true, new: true }
    )
    const number = '#' + String(counter.value + 1)
    const doc    = await Order.create({ ...req.body, number })
    broadcast('orders')
    res.status(201).json(doc)
  } catch(e) { res.status(400).json({ error: e.message }) }
})
ordersR.put('/:id', invalidateCache(['orders','delivery','pickup','dashboard']), withBroadcast('orders'), async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true })
    if (!order) return res.status(404).json({ error: 'Topilmadi' })

    // Shafyor biriktirilganda — pickup task ham yangilanadi va Telegram xabari ketadi
    const driverChanged = req.body.driver || req.body.driverId
    if (driverChanged) {
      const drv = req.body.driverId
        ? await Driver.findById(req.body.driverId).lean()
        : await Driver.findOne({ name: req.body.driver }).lean()

      if (drv) {
        // Pickup task topish yoki YARATISH — callback_data'da doim Task._id bo'lishi kerak
        let pickupTask = await Task.findOne(
          { orderId: order._id, type: 'pickup', deletedAt: { $exists: false } }
        )

        if (pickupTask) {
          // Mavjud task'ni yangilash
          await Task.findByIdAndUpdate(pickupTask._id,
            { $set: { driver: drv.name, driverId: drv._id } }
          )
          pickupTask = { ...pickupTask.toObject?.() || pickupTask, driver: drv.name, driverId: drv._id }
        } else {
          // Task yo'q — yangi yaratish
          pickupTask = await Task.create({
            orderId:   order._id,
            order:     order.number,
            type:      'pickup',
            status:    'yangi',
            customer:  order.customer,
            phone:     order.phone,
            address:   order.address,
            lat:       order.lat,
            lon:       order.lon,
            driver:    drv.name,
            driverId:  drv._id,
            auto:      true,
          })
        }

        // Telegram xabari — doim Task._id ishlatiladi
        if (drv.tgChatId) {
          require('../services/telegram').sendPickupToDriver(drv.tgChatId, {
            taskId:   String(pickupTask._id),
            order:    order.number,
            customer: order.customer,
            phone:    order.phone,
            address:  order.address,
            lat:      order.lat,
            lon:      order.lon,
            items:    [],
          }).catch(() => {})
        }
      }
    }

    res.json(order)
  } catch(e) { res.status(400).json({ error: e.message }) }
})
ordersR.delete('/:id', invalidateCache(['orders','dashboard']), withBroadcast('orders'), oc.remove)

/* Delivery — shafyor "olib ketish" topshiriqlari, real-time + cache */
const deliveryR = router()
const tc = ctrl(Task, ['order','customer','address'])
deliveryR.get('/', cacheGet(20), async (req,res) => { req.query.type='delivery'; return tc.getAll(req,res) })
deliveryR.get('/:id', tc.getOne)
deliveryR.post('/', invalidateCache(['delivery','dashboard']), withBroadcast('delivery'), async (req,res) => { req.body.type='delivery'; return tc.create(req,res) })
deliveryR.put('/:id', invalidateCache(['delivery','dashboard']), withBroadcast('delivery'), async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true })
    if (!task) return res.status(404).json({ error: 'Topilmadi' })
    // Shafyor biriktirilganda avtomatik Telegram xabari
    const driverAssigned = req.body.driverId || req.body.driver
    if (driverAssigned) {
      const drv = task.driverId
        ? await Driver.findById(task.driverId).lean()
        : await Driver.findOne({ name: task.driver }).lean()
      if (drv?.tgChatId) {
        require('../services/telegram').sendDeliveryToDriver(drv.tgChatId, {
          taskId: task._id.toString(), order: task.order,
          customer: task.customer, phone: task.phone,
          address: task.address, lat: task.lat, lon: task.lon,
          totalPrice: task.totalPrice||0, paid: task.paid||false,
          amountDue: task.paid ? 0 : (task.totalPrice||0), items: [],
        }).catch(()=>{})
        await Task.findByIdAndUpdate(task._id, { tgSent: true })
      }
    }
    res.json(task)
  } catch(e) { res.status(400).json({ error: e.message }) }
})
deliveryR.delete('/:id', invalidateCache(['delivery']), withBroadcast('delivery'), tc.remove)


/* Pickup */
/* Pickup — shafyor "olib kelish" topshiriqlari, real-time + cache */
const pickupR = router()
pickupR.get('/', cacheGet(20), async (req,res) => { req.query.type='pickup'; return tc.getAll(req,res) })
pickupR.get('/:id', tc.getOne)
pickupR.post('/', invalidateCache(['pickup','dashboard']), withBroadcast('pickup'), async (req,res) => { req.body.type='pickup'; return tc.create(req,res) })
pickupR.put('/:id', invalidateCache(['pickup','dashboard']), withBroadcast('pickup'), async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true })
    if (!task) return res.status(404).json({ error: 'Topilmadi' })
    const driverAssigned = req.body.driverId || req.body.driver
    if (driverAssigned) {
      const drv = task.driverId
        ? await Driver.findById(task.driverId).lean()
        : await Driver.findOne({ name: task.driver }).lean()
      if (drv?.tgChatId) {
        require('../services/telegram').sendPickupToDriver(drv.tgChatId, {
          taskId: task._id.toString(), order: task.order,
          customer: task.customer, phone: task.phone,
          address: task.address, lat: task.lat, lon: task.lon, items: [],
        }).catch(()=>{})
        await Task.findByIdAndUpdate(task._id, { tgSent: true })
      }
    }
    res.json(task)
  } catch(e) { res.status(400).json({ error: e.message }) }
})
pickupR.delete('/:id', invalidateCache(['pickup']), withBroadcast('pickup'), tc.remove)

/* Simple CRUD */
const employeesR = buildCached(Employee, ['name','phone'], 'employees', 120)
const driversR   = buildCached(Driver, ['name','phone','plate'], 'drivers', 60)

/* ── PIN generatsiya — /:id/generate-pin ──
   4 xonali noyob PIN yaratadi, DB ga saqlaydi.
   Ishchi/shafyor bu PIN bilan Telegram botga kiradi.
   MUHIM: bu route buildCached ichidagi GET /:id dan
   OLDIN ro'yxatdan o'tishi kerak, aks holda Express
   'generate-pin' ni ObjectId deb tushunib yuboradi. */

function generatePin() { return String(Math.floor(1000 + Math.random() * 9000)) }

async function ensureUniquePin(Model, excludeId) {
  let pin, tries = 0
  do {
    pin = generatePin()
    const exists = await Model.findOne({ pin, _id: { $ne: excludeId } })
    if (!exists) return pin
    tries++
  } while (tries < 20)
  throw new Error('Noyob PIN yaratib bo\'lmadi, qayta urinib ko\'ring')
}

employeesR.post('/:id/generate-pin', invalidateCache(['employees']), async (req, res) => {
  try {
    const pin = await ensureUniquePin(Employee, req.params.id)
    const emp = await Employee.findByIdAndUpdate(
      req.params.id,
      { $set: { pin, tgChatId: '' } },  // yangi PIN bilan eski TG ulanishi qayta tiklanadi
      { new: true }
    )
    if (!emp) return res.status(404).json({ error: 'Ishchi topilmadi' })
    broadcast('employees')
    res.json({ pin, name: emp.name, _id: emp._id })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

driversR.post('/:id/generate-pin', invalidateCache(['drivers']), async (req, res) => {
  try {
    const pin = await ensureUniquePin(Driver, req.params.id)
    const drv = await Driver.findByIdAndUpdate(
      req.params.id,
      { $set: { pin, tgChatId: '' } },  // yangi PIN bilan eski TG ulanishi qayta tiklanadi
      { new: true }
    )
    if (!drv) return res.status(404).json({ error: 'Shafyor topilmadi' })
    broadcast('drivers')
    res.json({ pin, name: drv.name, _id: drv._id })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
const customersR = buildCached(Customer, ['name','phone','address'], 'customers', 120)
const financeR   = buildCached(Finance, ['description','category'], 'finance', 30)
const salaryR    = buildCached(Salary, ['employee'], 'salary', 120)
const settingsR  = buildCached(Settings, ['key'], 'settings', 300)

/* ── Filial (Ximchistka) joylashuvi ──
   Bitta CRM bir nechta viloyatga o'rnatilishi mumkin — har bir
   o'rnatishda admin "📍 Joylashuvni saqlash" tugmasini bosib,
   filial markazini (lat/lon) bir marta belgilaydi. Shafyorlar
   xaritada shu nuqta atrofida kuzatiladi — Toshkent koordinatasi
   kod ichida QATTIQ YOZILMAGAN, har bir mijoz o'zinikini saqlaydi.

   MUHIM: bu route'lar buildCached() ichidagi generic GET /:id dan
   OLDIN qo'shilishi shart, aks holda Express '/company-location'
   satrini ":id" parametri deb tushunib, har doim Settings.findById
   ga yuborib yuborardi (404 yoki noto'g'ri natija). Shu sabab
   .stack ni qo'lda manipulyatsiya qilamiz — eng ishonchli yo'l:
   alohida sub-router yaratib, asosiy router'dan OLDIN ulaymiz. */
const companyLocationR = router()
companyLocationR.get('/', cacheGet(300), async (req, res) => {
  try {
    const doc = await Settings.findOne({ key: 'company_location' })
    res.json(doc?.value || null)
  } catch(e) { res.status(500).json({ error: e.message }) }
})
companyLocationR.put('/', invalidateCache(['settings']), withBroadcast('settings'), async (req, res) => {
  try {
    const { lat, lon, address, city } = req.body
    if (typeof lat !== 'number' || typeof lon !== 'number') {
      return res.status(400).json({ error: 'lat va lon raqam bo\'lishi shart' })
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return res.status(400).json({ error: 'Koordinata diapazondan tashqarida' })
    }
    const value = { lat, lon, address: address || '', city: city || '', savedAt: new Date() }
    await Settings.findOneAndUpdate(
      { key: 'company_location' },
      { key: 'company_location', value },
      { upsert: true }
    )
    res.json(value)
  } catch(e) { res.status(400).json({ error: e.message }) }
})

/* Archive */
const archiveR = router()
archiveR.get('/', cacheGet(120), async (req,res) => {
  try {
    const data = await Order.find({
      status:{ $in:['tugallandi','bekor'] },
      deletedAt:{ $exists:false }
    }).sort({ updatedAt:-1 }).limit(200).lean()
    res.json({ data, total: data.length })
  } catch(e) { res.status(500).json({ error:e.message }) }
})

/* Dashboard */
const dashR = router()

/* ── /api/dashboard/bootstrap — BITTA SO'ROV, BARCHA DATA ──
   Sahifa ochilishi bilan frontend shu endpointni bir marta chaqiradi.
   Barcha jadvallar, statistika — hammasi bir JSON da keladi.
   Keyin Socket.IO orqali faqat o'zgargan qismlar push qilinadi.
   Frontend boshqa alohida so'rov yubormaydi. */
dashR.get('/bootstrap', cacheGet(20), async (req, res) => {
  try {
    const [
      orders, drivers, employees, customers,
      delivery, pickup, finance, prices,
    ] = await Promise.all([
      Order.find({ deletedAt:{ $exists:false } }).sort({ createdAt:-1 }).limit(100).lean(),
      Driver.find({ deletedAt:{ $exists:false } }).lean(),
      Employee.find({ deletedAt:{ $exists:false } }).lean(),
      Customer.find({ deletedAt:{ $exists:false } }).sort({ createdAt:-1 }).limit(200).lean(),
      Task.find({ type:'delivery', deletedAt:{ $exists:false } }).sort({ createdAt:-1 }).limit(50).lean(),
      Task.find({ type:'pickup', deletedAt:{ $exists:false } }).sort({ createdAt:-1 }).limit(50).lean(),
      Finance.find({ deletedAt:{ $exists:false } }).sort({ createdAt:-1 }).limit(100).lean(),
      Price.find({ deletedAt:{ $exists:false } }).lean(),
    ])

    // Dashboard stats (inline — qo'shimcha query yo'q)
    const activeOrders = orders.filter(o => !['tugallandi','bekor'].includes(o.status)).length
    const finKirim  = finance.filter(f=>f.type==='kirim').reduce((s,f)=>s+(f.amount||0),0)
    const finChiqim = finance.filter(f=>f.type==='chiqim').reduce((s,f)=>s+(f.amount||0),0)

    res.json({
      orders,
      drivers,
      employees,
      customers,
      delivery,
      pickup,
      finance,
      prices,
      stats: {
        totalOrders:    orders.length,
        activeOrders,
        totalCustomers: customers.length,
        activeDrivers:  drivers.filter(d=>d.status==='faol').length,
        balance:        finKirim - finChiqim,
        todayRevenue:   finKirim,
        todayExpense:   finChiqim,
      },
      _ts: Date.now(),
    })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

dashR.get('/stats', cacheGet(20), async (req, res) => {
  try {
    const cache = require('../redis/cache')
    const cacheKey = 'dashboard:stats'
    const cached = await cache.get(cacheKey)
    if (cached) {
      res.set('X-Cache', 'HIT')
      return res.json({ ...cached, fromCache: true })
    }

    const [totalOrders, activeOrders, totalCustomers, activeDrivers] = await Promise.all([
      Order.countDocuments({ deletedAt:{ $exists:false } }),
      Order.countDocuments({ status:{ $nin:['tugallandi','bekor'] }, deletedAt:{ $exists:false } }),
      Customer.countDocuments({ deletedAt:{ $exists:false } }),
      Driver.countDocuments({ status:'faol' }),
    ])
    const fin = await Finance.aggregate([
      { $match:{ deletedAt:{ $exists:false } } },
      { $group:{ _id:'$type', total:{ $sum:'$amount' } } },
    ])
    const kirim  = fin.find(f=>f._id==='kirim')?.total  || 0
    const chiqim = fin.find(f=>f._id==='chiqim')?.total || 0
    const result = { totalOrders, activeOrders, totalCustomers, activeDrivers, todayRevenue:kirim, todayExpense:chiqim, balance:kirim-chiqim }

    await cache.set(cacheKey, result, 60)
    res.json(result)
  } catch(e) { res.status(500).json({ error:e.message }) }
})

const driverLiveR = require('./driverLive')

const telegramSettingsR = require('./telegramSettings')
const smsSettingsR      = require('./smsSettings')
const homeServiceR     = require('./homeService')
const attendanceR      = require('./attendance')
const salaryPaymentsR  = require('./salaryPayments')

module.exports = {
  authR:       require('./auth'),
  ordersR,
  deliveryR,
  pickupR,
  orderItemsR: require('./orderItems'),
  pricesR:     require('./prices'),
  employeesR,
  driversR,
  customersR,
  financeR,
  salaryR,
  settingsR,
  companyLocationR,
  archiveR,
  dashR,
  botR:        require('./bot'),
  driverLiveR,
  telegramSettingsR,
  smsSettingsR,
  homeServiceR,
  attendanceR,
  salaryPaymentsR,
}
