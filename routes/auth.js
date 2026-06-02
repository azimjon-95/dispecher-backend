const router  = require('express').Router()
const bcrypt  = require('bcryptjs')
const jwt     = require('jsonwebtoken')
const { Employee } = require('../models')

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body
    if (!phone || !password) return res.status(400).json({ error: 'Telefon va parol kiriting' })

    const emp = await Employee.findOne({ phone, deletedAt: { $exists: false } })

    // demo: accept any phone + password "admin123"
    if (!emp) {
      if (password !== 'admin123') return res.status(401).json({ error: "Noto'g'ri ma'lumot" })
      const token = jwt.sign({ id: 'demo', role: 'Super Admin' }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' })
      return res.json({ token, user: { name: 'Admin', role: 'Super Admin' } })
    }

    const ok = emp.pin ? await bcrypt.compare(password, emp.pin) : password === 'admin123'
    if (!ok) return res.status(401).json({ error: "Noto'g'ri parol" })

    const token = jwt.sign({ id: emp._id, role: emp.role }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' })
    res.json({ token, user: { _id: emp._id, name: emp.name, role: emp.role } })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/auth/logout
router.post('/logout', (_, res) => res.json({ ok: true }))

module.exports = router
