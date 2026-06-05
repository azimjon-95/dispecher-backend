'use strict'
const router   = require('express').Router()
const bcrypt   = require('bcryptjs')
const jwt      = require('jsonwebtoken')
const { Employee } = require('../models')
const { validate, authLimiter } = require('../middleware/security')
const cache    = require('../redis/cache')

const JWT_SECRET  = process.env.JWT_SECRET
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h'

/* ── Validate JWT_SECRET on startup ── */
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('🚨 XAVFSIZLIK XATOSI: JWT_SECRET .env da kamida 32 belgi bo\'lishi kerak!')
  console.error('   Yarating: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"')
}

/* ── Token blacklist (logout) ── */
const BLACKLIST_PREFIX = 'jwt:blacklist:'

async function isBlacklisted(jti) {
  return cache.exists(BLACKLIST_PREFIX + jti)
}

async function blacklistToken(jti, expiresIn) {
  await cache.set(BLACKLIST_PREFIX + jti, '1', expiresIn)
}

/* ── POST /api/auth/login ── */
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { phone, password } = req.body

    // Input validation
    if (!phone || !password) {
      return res.status(400).json({ error: 'Telefon va parol kiriting' })
    }
    if (typeof password !== 'string' || password.length > 100) {
      return res.status(400).json({ error: "Noto'g'ri ma'lumot" })
    }

    // Generic error message (timing attack oldini olish)
    const authFail = () => res.status(401).json({ error: "Telefon yoki parol noto'g'ri" })

    // Admin demo faqat ADMIN_PASSWORD env da bo'lsa ishlaydi
    const ADMIN_PWD = process.env.ADMIN_PASSWORD
    if (!ADMIN_PWD) {
      console.error('🚨 ADMIN_PASSWORD .env da yo\'q!')
    }

    const cleanPhone = String(phone).trim()

    // DB dan izlash
    const emp = await Employee.findOne({
      phone: cleanPhone,
      deletedAt: { $exists: false },
    }).select('+pin')

    if (!emp) {
      // Admin fallback — faqat env da bo'lsa
      if (ADMIN_PWD && password === ADMIN_PWD) {
        const jti   = require('crypto').randomBytes(16).toString('hex')
        const token = jwt.sign(
          { id:'admin', role:'Super Admin', jti },
          JWT_SECRET,
          { expiresIn: JWT_EXPIRES }
        )
        return res.json({ token, user: { name:'Admin', role:'Super Admin' } })
      }
      // Constant time comparison (timing attack)
      await bcrypt.compare(password, '$2b$10$fakefakefakefakefakefakefakefakefakefake')
      return authFail()
    }

    // PIN/password tekshirish
    let ok = false
    if (emp.pin) {
      // PIN bcrypt hash bilan
      ok = await bcrypt.compare(password, emp.pin)
      if (!ok && ADMIN_PWD) {
        ok = password === ADMIN_PWD // Admin master password
      }
    } else if (ADMIN_PWD) {
      ok = password === ADMIN_PWD
    }

    if (!ok) return authFail()

    if (emp.status === 'inactive') {
      return res.status(403).json({ error: 'Hisobingiz faol emas' })
    }

    const jti   = require('crypto').randomBytes(16).toString('hex')
    const token = jwt.sign(
      { id: emp._id, role: emp.role, jti },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    )

    res.json({
      token,
      user: { _id: emp._id, name: emp.name, role: emp.role, section: emp.section }
    })

  } catch (e) {
    console.error('Login error:', e.message)
    res.status(500).json({ error: 'Server xatosi' })  // Stack trace leak yo'q
  }
})

/* ── POST /api/auth/logout ── */
router.post('/logout', async (req, res) => {
  try {
    const header = req.headers.authorization
    if (header?.startsWith('Bearer ')) {
      const token = header.slice(7)
      const payload = jwt.decode(token)
      if (payload?.jti) {
        const exp = payload.exp ? payload.exp - Math.floor(Date.now()/1000) : 3600
        await blacklistToken(payload.jti, Math.max(exp, 60))
      }
    }
    res.json({ ok: true })
  } catch { res.json({ ok: true }) }
})

/* ── GET /api/auth/me ── */
router.get('/me', require('../middleware/auth'), async (req, res) => {
  try {
    if (req.user.id === 'admin') {
      return res.json({ name:'Admin', role:'Super Admin' })
    }
    const emp = await Employee.findById(req.user.id).select('name role section status')
    if (!emp) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' })
    res.json(emp)
  } catch (e) {
    res.status(500).json({ error: 'Server xatosi' })
  }
})

/* ── POST /api/auth/change-password ── */
router.post('/change-password', require('../middleware/auth'), async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body
    if (!oldPassword || !newPassword) return res.status(400).json({ error: "Parollarni kiriting" })
    if (newPassword.length < 6) return res.status(400).json({ error: "Parol kamida 6 belgi" })
    if (newPassword.length > 100) return res.status(400).json({ error: "Parol juda uzun" })

    if (req.user.id === 'admin') return res.status(400).json({ error: "Admin parolini .env dan o'zgartiring" })

    const emp = await Employee.findById(req.user.id).select('+pin')
    if (!emp) return res.status(404).json({ error: 'Topilmadi' })

    const ok = emp.pin ? await bcrypt.compare(oldPassword, emp.pin) : oldPassword === process.env.ADMIN_PASSWORD
    if (!ok) return res.status(401).json({ error: "Eski parol noto'g'ri" })

    emp.pin = await bcrypt.hash(newPassword, 12)
    await emp.save()
    res.json({ ok: true, message: 'Parol yangilandi' })
  } catch (e) {
    res.status(500).json({ error: 'Server xatosi' })
  }
})

module.exports = router
