'use strict'
const jwt   = require('jsonwebtoken')
const cache = require('../redis/cache')

const ROLE_PERMS = {
  'Super Admin': '*',
  'Dispecher':   ['orders','delivery','pickup','customers','employees','drivers','attendance'],
  'Buxgalter':   ['finance','salary','salary-payments'],
  'Menejer':     ['orders','customers','finance','dashboard'],
  'Ishchi':      ['order-items','attendance'],
  'Shafyor':     ['delivery','pickup'],
}

module.exports = async function auth(req, res, next) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: "Kirish uchun tizimga kiring" })
  }

  const token = header.slice(7)
  if (!token || token.length < 10) {
    return res.status(401).json({ error: "Token noto'g'ri" })
  }

  const secret = process.env.JWT_SECRET
  if (!secret) {
    console.error('JWT_SECRET not set!')
    return res.status(500).json({ error: 'Server konfiguratsiya xatosi' })
  }

  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],    // Faqat HS256 algoritm
      issuer:     undefined,
      audience:   undefined,
    })

    // Token blacklist tekshirish (logout qilinganlarni bloklash)
    if (payload.jti) {
      const blacklisted = await cache.exists('jwt:blacklist:' + payload.jti)
      if (blacklisted) {
        return res.status(401).json({ error: "Siz tizimdan chiqib ketgansiz. Qayta kiring." })
      }
    }

    req.user = payload
    next()
  } catch (e) {
    if (e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: "Sessiya muddati tugadi. Qayta kiring." })
    }
    if (e.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: "Token noto'g'ri" })
    }
    return res.status(401).json({ error: "Autentifikatsiya xatosi" })
  }
}

/* ── Role-based access ── */
module.exports.requireRole = function(...roles) {
  return (req, res, next) => {
    const userRole = req.user?.role
    if (!userRole) return res.status(403).json({ error: "Ruxsat yo'q" })
    if (roles.includes(userRole) || userRole === 'Super Admin') return next()
    return res.status(403).json({ error: `Bu amalni bajarish uchun ${roles.join(' yoki ')} roli kerak` })
  }
}

/* ── Permission check ── */
module.exports.requirePerm = function(resource) {
  return (req, res, next) => {
    const role  = req.user?.role
    const perms = ROLE_PERMS[role]
    if (!perms) return res.status(403).json({ error: "Ruxsat yo'q" })
    if (perms === '*' || perms.includes(resource)) return next()
    return res.status(403).json({ error: "Bu bo'limga kirish ruxsati yo'q" })
  }
}
