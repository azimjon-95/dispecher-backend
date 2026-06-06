'use strict'
/**
 * SECURITY MIDDLEWARE STACK
 * 
 * Himoya qatlamlari:
 * 1. Helmet       — HTTP headers xavfsizligi
 * 2. Rate Limit   — Brute force himoya
 * 3. Mongo Sanitize — NoSQL injection
 * 4. XSS Clean    — Cross-site scripting
 * 5. HPP          — HTTP Parameter Pollution
 * 6. Input Validate — Ma'lumot tekshiruvi
 */

const helmet         = require('helmet')
const rateLimit      = require('express-rate-limit')
const mongoSanitize  = require('express-mongo-sanitize')
const xss            = require('xss-clean')
const hpp            = require('hpp')
const validator      = require('validator')

/* ── 1. HELMET — HTTP Security Headers ── */
const helmetConfig = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      styleSrc:       ["'self'", "'unsafe-inline'"],
      scriptSrc:      ["'self'"],
      imgSrc:         ["'self'", 'data:', 'https:'],
      connectSrc:     ["'self'", 'wss:', 'https:'],
      fontSrc:        ["'self'"],
      objectSrc:      ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
  xFrameOptions: { action: 'deny' },
})

/* ── 2. RATE LIMITERS ── */

// Global: barcha API uchun
const globalLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             500,
  message:         { error: "Juda ko'p so'rov. 15 daqiqadan keyin urinib ko'ring." },
  standardHeaders: true,
  legacyHeaders:   false,
  skip:            (req) => req.path === '/health',
  keyGenerator:    (req) => {
    const forwarded = req.headers['x-forwarded-for']
    const ip = forwarded ? forwarded.split(',')[0].trim() : (req.socket?.remoteAddress || 'unknown')
    return ip.replace(/[^a-zA-Z0-9._-]/g, '_')
  },
})

// Auth: login uchun qattiq cheklash
const authLimiter = rateLimit({
  windowMs:               15 * 60 * 1000,
  max:                    10,
  message:                { error: "Juda ko'p noto'g'ri urinish. 15 daqiqadan keyin urinib ko'ring." },
  skipSuccessfulRequests: true,
  standardHeaders:        true,
  legacyHeaders:          false,
  keyGenerator: (req) => {
    const forwarded = req.headers['x-forwarded-for']
    const ip = forwarded ? forwarded.split(',')[0].trim() : (req.socket?.remoteAddress || 'unknown')
    return ip.replace(/[^a-zA-Z0-9._-]/g, '_')
  },
  handler: (req, res) => {
    console.warn('🚨 BRUTE FORCE urinish: ' + req.path)
    res.status(429).json({ error: "Juda ko'p urinish. Keyinroq urinib ko'ring." })
  },
})

// Bot: Telegram bot endpointlari
const botLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max:      60,
  message:  { error: 'Bot so\'rov limiti oshdi.' },
})

// Driver live location
const driverLimiter = rateLimit({
  windowMs: 10 * 1000,
  max:      3,
  message:  { error: 'Location yuborish limiti.' },
  keyGenerator: (req) => {
    const id = req.body?.telegramId
    if (id) return 'drv_' + String(id)
    const forwarded = req.headers['x-forwarded-for']
    const ip = forwarded ? forwarded.split(',')[0].trim() : (req.socket?.remoteAddress || 'unknown')
    return ip.replace(/[^a-zA-Z0-9._-]/g, '_')
  },
  skip: (req) => !req.body?.telegramId,
})

/* ── 3. MONGO SANITIZE — NoSQL Injection ── */
// { "$gt": "" } → tozalanadi
const mongoSanitizeConfig = mongoSanitize({
  replaceWith: '_',
  onSanitize: ({ req, key }) => {
    console.warn(`🚨 NoSQL Injection urinish: ${req.ip} → key: ${key}`)
  },
})

/* ── 4. INPUT VALIDATION HELPERS ── */
const validate = {
  /* Phone number (O'zbekiston formati) */
  phone: (p) => {
    if (!p) return false
    const clean = String(p).replace(/\s/g, '')
    return /^(\+998|998)?[0-9]{9}$/.test(clean)
  },

  /* MongoDB ObjectId */
  objectId: (id) => /^[a-f\d]{24}$/i.test(String(id || '')),

  /* Safe string — injection harflarsiz */
  safeString: (s, maxLen = 500) => {
    if (s === null || s === undefined) return true
    if (typeof s === 'object') return false  // Object passed as string
    const str = String(s)
    if (str.length > maxLen) return false
    if (/\$\w+/.test(str)) return false              // MongoDB operators
    if (/<script[\s\S]*?>/i.test(str)) return false  // XSS script tag
    if (/javascript\s*:/i.test(str)) return false     // JS protocol
    if (/on\w+\s*=/i.test(str)) return false          // Event handlers
    if (/<[a-z][\s\S]*>/i.test(str)) return false    // Any HTML tag
    return true
  },

  /* Number range */
  amount: (n, min = 0, max = 999_999_999) => {
    const num = Number(n)
    return !isNaN(num) && num >= min && num <= max
  },

  /* Sanitize string (XSS) */
  clean: (s) => {
    if (!s) return s
    return String(s)
      .replace(/<[^>]*>/g, '')           // HTML teglarini olib tashlash
      .replace(/javascript:/gi, '')       // JS protocol
      .replace(/on\w+\s*=/gi, '')        // Event handlers
      .replace(/[<>'"]/g, c => ({        // Xavfli belgilar
        '<': '&lt;', '>': '&gt;',
        "'": '&#x27;', '"': '&quot;'
      }[c]))
      .trim()
      .slice(0, 1000)
  },

  /* Sanitize object recursively */
  cleanObject: (obj, depth = 0) => {
    if (depth > 5 || !obj || typeof obj !== 'object') return obj
    const clean = {}
    for (const [k, v] of Object.entries(obj)) {
      // Key ni tekshirish (MongoDB operator bo'lmasin)
      if (/^\$/.test(k) || /\./.test(k)) continue
      if (typeof v === 'string')      clean[k] = validate.clean(v)
      else if (typeof v === 'object') clean[k] = validate.cleanObject(v, depth + 1)
      else                            clean[k] = v
    }
    return clean
  },
}

/* ── 5. BODY SANITIZATION MIDDLEWARE ── */
function sanitizeBody(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = validate.cleanObject(req.body)
  }
  next()
}

/* ── 6. SECURITY HEADERS (qo'shimcha) ── */
function extraHeaders(req, res, next) {
  res.removeHeader('X-Powered-By')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.setHeader('Permissions-Policy', 'geolocation=(self), microphone=()')
  next()
}

/* ── 7. REQUEST LOGGING (xavfsizlik log) ── */
function securityLog(req, res, next) {
  // Shubhali pattern lar
  const suspiciousPatterns = [
    /\$\w+/,          // MongoDB operators
    /<script/i,       // XSS
    /javascript:/i,   // JS injection
    /union.*select/i, // SQL injection (ehtiyot uchun)
    /etc\/passwd/i,   // Path traversal
    /\.\.\//,         // Directory traversal
    /eval\s*\(/i,     // Code injection
  ]

  const checkString = JSON.stringify({
    body: req.body, query: req.query, params: req.params
  })

  const found = suspiciousPatterns.find(p => p.test(checkString))
  if (found) {
    console.warn(`🚨 XAVFLI SO'ROV: ${req.ip} → ${req.method} ${req.path}`)
    // Block etmaymiz — log yozamiz (false positive bo'lmasin deb)
    req.suspicious = true
  }

  next()
}

/* ── 8. IP WHITELIST/BLACKLIST (ixtiyoriy) ── */
const ipBlacklist = new Set()
const IP_BLOCK_THRESHOLD = 20 // 20 ta shubhali so'rovdan keyin bloklash

const ipWarnings = new Map()

function ipGuard(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress

  if (ipBlacklist.has(ip)) {
    return res.status(403).json({ error: 'Kirish taqiqlangan' })
  }

  if (req.suspicious) {
    const count = (ipWarnings.get(ip) || 0) + 1
    ipWarnings.set(ip, count)
    if (count >= IP_BLOCK_THRESHOLD) {
      ipBlacklist.add(ip)
      console.warn(`🚫 IP BLOKLANDI: ${ip}`)
    }
  }

  next()
}

module.exports = {
  helmetConfig,
  globalLimiter,
  authLimiter,
  botLimiter,
  driverLimiter,
  mongoSanitizeConfig,
  sanitizeBody,
  extraHeaders,
  securityLog,
  ipGuard,
  validate,
}
