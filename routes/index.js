const router = require('express').Router
const ctrl   = require('../controllers/crudCtrl')
const {
  Order, Task,
  Employee, Driver, Customer,
  Finance, Salary, Settings,
} = require('../models')

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

/* Orders with auto-number */
const ordersR = router()
const oc = ctrl(Order, ['customer','phone','address','number'])
ordersR.get('/',    oc.getAll)
ordersR.get('/:id', oc.getOne)
ordersR.post('/', async (req, res) => {
  try {
    const count  = await Order.countDocuments()
    const number = '#' + String(1000 + count + 1)
    const doc    = await Order.create({ ...req.body, number })
    res.status(201).json(doc)
  } catch(e) { res.status(400).json({ error: e.message }) }
})
ordersR.put('/:id',    oc.update)
ordersR.delete('/:id', oc.remove)

/* Delivery */
const deliveryR = router()
const tc = ctrl(Task, ['order','customer','address'])
deliveryR.get('/', async (req,res) => { req.query.type='delivery'; return tc.getAll(req,res) })
deliveryR.get('/:id', tc.getOne)
deliveryR.post('/', async (req,res) => { req.body.type='delivery'; return tc.create(req,res) })
deliveryR.put('/:id', tc.update)
deliveryR.delete('/:id', tc.remove)

/* Pickup */
const pickupR = router()
pickupR.get('/', async (req,res) => { req.query.type='pickup'; return tc.getAll(req,res) })
pickupR.get('/:id', tc.getOne)
pickupR.post('/', async (req,res) => { req.body.type='pickup'; return tc.create(req,res) })
pickupR.put('/:id', tc.update)
pickupR.delete('/:id', tc.remove)

/* Simple CRUD */
const employeesR = build(Employee,   ['name','phone'])
const driversR   = build(Driver,     ['name','phone','plate'])
const customersR = build(Customer,   ['name','phone','address'])
const financeR   = build(Finance,    ['description','category'])
const salaryR    = build(Salary,     ['employee'])
const settingsR  = build(Settings,   ['key'])

/* Archive */
const archiveR = router()
archiveR.get('/', async (req,res) => {
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
dashR.get('/stats', async (req, res) => {
  try {
    const cache = require('../redis/cache')
    const cacheKey = 'dashboard:stats'
    const cached = await cache.get(cacheKey)
    if (cached) return res.json({ ...cached, fromCache: true })

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
  archiveR,
  dashR,
  botR:        require('./bot'),
  driverLiveR,
  telegramSettingsR,
  smsSettingsR,
}
