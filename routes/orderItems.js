'use strict'
const router       = require('express').Router()
const cache = require('../redis/cache')
const { cacheGet, invalidateCache, invalidatePrefix } = require('../redis/cacheMiddleware')
const { broadcast, withBroadcast } = require('./_broadcast')
const { OrderItem, Order, Employee, Finance, Task } = require('../models')
const { syncOrderStats, advanceOrderItem, ETAP_LABEL } = require('../services/orderSync')

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
router.post('/', invalidateCache(['order-items', 'orders', 'dashboard']), withBroadcast('order-items'), async (req, res) => {
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
router.put('/:id', invalidateCache(['order-items', 'orders', 'dashboard']), withBroadcast('order-items'), async (req, res) => {
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
router.delete('/:id', invalidateCache(['order-items', 'orders', 'dashboard']), withBroadcast('order-items'), async (req, res) => {
  try {
    const item = await OrderItem.findByIdAndUpdate(req.params.id, { deletedAt: new Date() }, { new: true })
    if (item) await syncOrderStats(item.orderId)
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

/* ─── POST /api/order-items/:id/assign ─── */
// FAQAT ishchi biriktiriladi, stage O'ZGARMAYDI
router.post('/:id/assign', invalidateCache(['order-items', 'orders']), withBroadcast('order-items'), async (req, res) => {
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
// Bu botdan ham (Telegram tugma) chaqiriladi — services/orderSync.js
// orqali bir xil mantiq ishlatiladi, natija CRM da DARHOL ko'rinadi.
router.post('/:id/advance', invalidateCache(['order-items', 'orders', 'employees', 'dashboard']), withBroadcast('order-items'), async (req, res) => {
  try {
    const result = await advanceOrderItem(req.params.id)
    res.json(result)
  } catch(e) { res.status(e.status || 500).json({ error: e.message }) }
})

/* ─── GET /api/order-items/by-stage/:stage ─── */
router.get('/by-stage/:stage', cacheGet(15), async (req, res) => {
  try {
    const items = await OrderItem.find({ stage: req.params.stage, deletedAt:{ $exists:false } }).sort({ createdAt: -1 }).limit(100)
    res.json(items)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

module.exports = router
