'use strict'
const router = require('express').Router()
const cache = require('../redis/cache')
const { cacheGet, invalidateCache, invalidatePrefix } = require('../redis/cacheMiddleware')
const { broadcast, withBroadcast } = require('./_broadcast')
const { HomeService, Employee, Finance, SalaryPayment } = require('../models')

/* auto-number */
async function nextNumber() {
  const last = await HomeService.findOne().sort({ createdAt:-1 }).select('number')
  const n    = parseInt(last?.number?.replace('H','') || '0') + 1
  return 'H' + String(n).padStart(4,'0')
}

/* GET */
router.get('/', cacheGet(60), async (req,res) => {
  try {
    const q = { deletedAt:{ $exists:false } }
    if (req.query.status) q.status = req.query.status
    const list = await HomeService.find(q).sort({ createdAt:-1 }).limit(200)
    res.json(list)
  } catch(e) { res.status(500).json({ error:e.message }) }
})

/* POST */
router.post('/', invalidateCache(['home-service', 'dashboard', 'finance']), withBroadcast('home-service'), async (req,res) => {
  try {
    const number = await nextNumber()
    const svc    = await HomeService.create({ ...req.body, number })
    res.status(201).json(svc)
  } catch(e) { res.status(400).json({ error:e.message }) }
})

/* PUT */
router.put('/:id', invalidateCache(['home-service', 'dashboard', 'finance']), withBroadcast('home-service'), async (req,res) => {
  try {
    const svc = await HomeService.findByIdAndUpdate(req.params.id, { $set:req.body }, { new:true })
    res.json(svc)
  } catch(e) { res.status(400).json({ error:e.message }) }
})

/* DELETE */
router.delete('/:id', invalidateCache(['home-service', 'dashboard', 'finance']), withBroadcast('home-service'), async (req,res) => {
  try {
    await HomeService.findByIdAndUpdate(req.params.id, { deletedAt:new Date() })
    res.json({ ok:true })
  } catch(e) { res.status(500).json({ error:e.message }) }
})

/* POST /api/home-service/:id/complete — Xizmat bajarildi, pul olindi */
router.post('/:id/complete', invalidateCache(['home-service', 'dashboard', 'finance', 'salary-payments']), withBroadcast('home-service'), async (req,res) => {
  try {
    const { totalAmount, paidAmount, description, workers } = req.body
    const svc = await HomeService.findById(req.params.id)
    if (!svc) return res.status(404).json({ error:'Topilmadi' })

    svc.totalAmount   = totalAmount || svc.totalAmount
    svc.paidAmount    = paidAmount  || svc.paidAmount
    svc.status        = 'bajarildi'
    if (description)  svc.description = description
    if (workers)      svc.workers     = workers
    await svc.save()

    const paid = paidAmount || totalAmount || 0

    // Finance: kirim
    if (paid > 0) {
      await Finance.create({
        type:        'kirim',
        description: `Uy xizmati ${svc.number} — ${svc.customer}`,
        amount:      paid,
        category:    'Uy xizmati',
        orderId:     svc._id,
        date:        new Date().toISOString().slice(0,10),
        by:          'Admin',
      })
    }

    // Ishchilar balansi: totalPercent / workerCount
    const workList = workers || svc.workers || []
    if (workList.length > 0 && paid > 0) {
      const totalPct  = svc.workerPercent || 10  // % total
      const totalEarn = Math.round(paid * totalPct / 100)
      const perWorker = Math.round(totalEarn / workList.length)

      for (const w of workList) {
        await Employee.findByIdAndUpdate(w.workerId, { $inc:{ balance: perWorker } })
        await SalaryPayment.create({
          employeeId:   w.workerId,
          employeeName: w.workerName,
          type:         'oylik',
          amount:       perWorker,
          note:         `Uy xizmati ${svc.number} — ${totalPct}% / ${workList.length} ishchi`,
          date:         new Date().toISOString().slice(0,10),
        })
      }
    }

    res.json({ ok:true, svc })
  } catch(e) { res.status(500).json({ error:e.message }) }
})

module.exports = router
