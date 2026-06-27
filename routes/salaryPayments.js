'use strict'
const router = require('express').Router()
const cache = require('../redis/cache')
const { cacheGet, invalidateCache, invalidatePrefix } = require('../redis/cacheMiddleware')
const { SalaryPayment, Employee } = require('../models')

/* GET */
router.get('/', cacheGet(60), async (req,res) => {
  try {
    const q = {}
    if (req.query.employeeId) q.employeeId = req.query.employeeId
    if (req.query.type)       q.type       = req.query.type
    if (req.query.month)      q.date       = { $regex:'^'+req.query.month }
    const list = await SalaryPayment.find(q).sort({ createdAt:-1 }).limit(500)
    res.json(list)
  } catch(e) { res.status(500).json({ error:e.message }) }
})

/* POST — avans, oylik, jarima, bonus */
router.post('/', invalidateCache(['salary-payments', 'salary', 'dashboard']), async (req,res) => {
  try {
    const { employeeId, type, amount, note, date } = req.body
    if (!employeeId || !amount) return res.status(400).json({ error:'employeeId va amount kerak' })

    const emp = await Employee.findById(employeeId)
    if (!emp) return res.status(404).json({ error:'Ishchi topilmadi' })

    const pay = await SalaryPayment.create({
      employeeId, employeeName: emp.name, type, amount, note,
      date: date || new Date().toISOString().slice(0,10),
      paidBy: req.body.paidBy || 'Admin',
    })

    // Balance adjustment
    if (type === 'oylik' || type === 'avans') {
      // balance kamayadi — pul berildi
      await Employee.findByIdAndUpdate(employeeId, { $inc:{ balance: -Math.abs(amount) } })
    } else if (type === 'jarima') {
      await Employee.findByIdAndUpdate(employeeId, { $inc:{ balance: -Math.abs(amount) } })
    } else if (type === 'bonus') {
      await Employee.findByIdAndUpdate(employeeId, { $inc:{ balance: Math.abs(amount) } })
    }

    res.status(201).json(pay)
  } catch(e) { res.status(400).json({ error:e.message }) }
})

/* GET monthly summary per employee */
router.get('/summary/:month', async (req,res) => {
  try {
    const { month } = req.params  // 2026-06
    const employees = await Employee.find({ status:'active' })
    const payments  = await SalaryPayment.find({ date:{ $regex:'^'+month } })

    const summary = employees.map(emp => {
      const pays = payments.filter(p => String(p.employeeId)===String(emp._id))
      const avans   = pays.filter(p=>p.type==='avans').reduce((s,p)=>s+p.amount,0)
      const oylik   = pays.filter(p=>p.type==='oylik').reduce((s,p)=>s+p.amount,0)
      const jarima  = pays.filter(p=>p.type==='jarima').reduce((s,p)=>s+p.amount,0)
      const bonus   = pays.filter(p=>p.type==='bonus').reduce((s,p)=>s+p.amount,0)

      // Expected salary based on type
      let expected = 0
      if (emp.salaryType==='Oylik')  expected = emp.salary || 0
      if (emp.salaryType==='Kunlik') expected = (emp.dailyRate||0) * 26
      if (emp.salaryType==='Ish bayi') expected = emp.balance || 0  // from work

      const remaining = expected + bonus - avans - oylik - jarima

      return { ...emp.toObject(), avans, oylik, jarima, bonus, expected, remaining, currentBalance: emp.balance }
    })

    res.json(summary)
  } catch(e) { res.status(500).json({ error:e.message }) }
})

module.exports = router
