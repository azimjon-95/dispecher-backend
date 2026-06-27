'use strict'
const router = require('express').Router()
const cache = require('../redis/cache')
const { cacheGet, invalidateCache, invalidatePrefix } = require('../redis/cacheMiddleware')
const { Attendance, Employee } = require('../models')

/* GET /api/attendance?date=2026-06-01 */
router.get('/', cacheGet(30), async (req,res) => {
  try {
    const q = {}
    if (req.query.date)       q.date       = req.query.date
    if (req.query.employeeId) q.employeeId = req.query.employeeId
    if (req.query.month) {
      q.date = { $regex: '^' + req.query.month }  // 2026-06
    }
    const list = await Attendance.find(q).sort({ date:-1, createdAt:-1 })
    res.json(list)
  } catch(e) { res.status(500).json({ error:e.message }) }
})

/* POST /api/attendance — qo'lda yoki bot orqali */
router.post('/', invalidateCache(['attendance', 'dashboard']), async (req,res) => {
  try {
    const { employeeId, date, checkIn, status, tgChatId, note } = req.body
    if (!employeeId || !date) return res.status(400).json({ error:'employeeId va date kerak' })

    // Upsert — bir kun faqat bitta yozuv
    const rec = await Attendance.findOneAndUpdate(
      { employeeId, date },
      { $set: { employeeId, date, checkIn: checkIn||new Date().toTimeString().slice(0,5), status: status||'keldi', tgChatId, note } },
      { upsert:true, new:true }
    )
    res.json(rec)
  } catch(e) { res.status(400).json({ error:e.message }) }
})

/* PUT checkout */
router.put('/:id/checkout', async (req,res) => {
  try {
    const rec = await Attendance.findByIdAndUpdate(req.params.id,
      { $set:{ checkOut: new Date().toTimeString().slice(0,5) } }, { new:true })
    res.json(rec)
  } catch(e) { res.status(500).json({ error:e.message }) }
})

/* GET today summary */
router.get('/today', async (req,res) => {
  try {
    const today = new Date().toISOString().slice(0,10)
    const records = await Attendance.find({ date:today })
    const employees = await Employee.find({ status:'active' }).select('name role section')
    
    const present  = records.filter(r=>r.status==='keldi').length
    const absent   = employees.length - present
    const list     = employees.map(e => {
      const att = records.find(r=>String(r.employeeId)===String(e._id))
      return { ...e.toObject(), attendance: att || null }
    })
    res.json({ today, total: employees.length, present, absent, list })
  } catch(e) { res.status(500).json({ error:e.message }) }
})

module.exports = router
