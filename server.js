require('dotenv').config()
const express   = require('express')
const mongoose  = require('mongoose')
const cors      = require('cors')
const auth      = require('./middleware/auth')
const xssClean  = require('xss-clean')
const {
  helmetConfig, globalLimiter, mongoSanitizeConfig,
  sanitizeBody, extraHeaders, securityLog, ipGuard
} = require('./middleware/security')
const morgan    = require('morgan')
const http      = require('http')
const { Server } = require('socket.io')

const R = require('./routes')

const app    = express()
const server = http.createServer(app)
const io     = new Server(server, {
  cors: { origin: process.env.CLIENT_URL || 'http://localhost:3000', credentials: true }
})

// ── CORS ──
const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:3000').split(',').map(o=>o.trim())
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true)
    cb(new Error('CORS: ruxsat berilmagan manba'))
  },
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}))

// ── SECURITY ──
app.use(helmetConfig)
app.use(extraHeaders)
app.use(globalLimiter)
app.use(mongoSanitizeConfig)
app.use(xssClean())
app.use(sanitizeBody)
app.use(securityLog)
app.use(ipGuard)
app.use(express.json())
app.use(morgan('dev'))

// ── Socket.IO ──
global.__io = io

io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id)

  socket.on('join:admin', () => {
    socket.join('admin')
    console.log(`👤 Admin joined: ${socket.id}`)
  })

  socket.on('driver:location-update', async (data) => {
    try {
      const cache   = require('./redis/cache')
      const payload = { ...data, online: true, updatedAt: new Date().toISOString() }
      await cache.set(`driver:live:${data.telegramId}`, payload, 60)
      io.to('admin').emit('driver:live-location', payload)
    } catch {}
  })

  socket.on('disconnect', () => console.log('🔌 Disconnected:', socket.id))
})
app.set('io', io)

// ── MongoDB ──
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/dispecher')

mongoose.connection.once('open', async () => {
  console.log('✅ MongoDB connected')

  // Cache warmup
  try {
    const { warmup } = require('./redis/cacheMiddleware')
    warmup(require('./models')).catch(() => {})
  } catch {}

  // Telegram sozlamalari faqat .env dan — DB ga yozilmaydi
  if (process.env.BOT_TOKEN) {
    console.log('✅ Telegram Bot: BOT_TOKEN topildi')
  } else {
    console.warn("⚠️  BOT_TOKEN .env da yo'q")
  }

  // DB dagi eski telegram sozlamalarini tozalash
  try {
    const { Settings } = require('./models')
    await Settings.deleteMany({
      key: { $in: ['BOT_TOKEN','BOT_USERNAME','ADMIN_CHAT_ID','WEBAPP_URL','telegram'] }
    })
  } catch {}
})

mongoose.connection.on('error', (e) => {
  console.error('❌ MongoDB:', e.message)
})

// ── Redis status ──
const cache = require('./redis/cache')
setTimeout(() => console.log(`📦 Cache: ${cache.status()}`), 2000)

// ── Routes ──
app.use('/api/auth',              R.authR)
app.use('/api/orders',            auth, R.ordersR)
app.use('/api/order-items',       R.orderItemsR)
app.use('/api/prices',            R.pricesR)
app.use('/api/delivery',          R.deliveryR)
app.use('/api/pickup',            R.pickupR)
app.use('/api/employees',         auth, R.employeesR)
app.use('/api/drivers',           R.driversR)
app.use('/api/customers',         R.customersR)
app.use('/api/finance',           auth, R.financeR)
app.use('/api/salary',            R.salaryR)
app.use('/api/settings',          R.settingsR)
app.use('/api/archive',           R.archiveR)
app.use('/api/dashboard',         R.dashR)
app.use('/api/driver',            R.driverLiveR)
app.use('/api/telegram-settings', R.telegramSettingsR)
app.use('/api/sms-settings',      R.smsSettingsR)
app.use('/api/home-service',      R.homeServiceR)
app.use('/api/attendance',        R.attendanceR)
app.use('/api/salary-payments',   R.salaryPaymentsR)
app.use('/api/bot',               R.botR)

// ── Health ──
app.head('/health', (_, res) => res.sendStatus(200))
app.get('/health',  (_, res) => res.json({
  status: 'ok',
  time:   new Date().toISOString(),
  cache:  cache.status(),
}))

// ── Driver live GPS — faqat Redis ──
app.get('/api/driver/live-locations', async (req, res) => {
  try {
    const keys = await cache.keys('driver_loc:*')
    if (!keys.length) return res.json([])
    const locs = []
    for (const key of keys) {
      try {
        const raw = await cache.get(key)
        if (!raw) continue
        const loc = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (loc.ts && Date.now() - loc.ts > 300000) continue
        locs.push(loc)
      } catch {}
    }
    res.set('X-Cache', 'REDIS')
    res.json(locs)
  } catch { res.json([]) }
})

// ── 404 & Error handler ──
app.use((_, res) => res.status(404).json({ error: 'Route topilmadi' }))
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({ error: err.message })
})

const PORT = process.env.PORT || 5000
server.listen(PORT, () => {
  console.log(`🚀 Server: http://localhost:${PORT}`)
  console.log(`🤖 Bot API: http://localhost:${PORT}/api/bot`)
  console.log(`📊 Dashboard: http://localhost:${PORT}/api/dashboard/stats`)
})

module.exports = { app, io }
