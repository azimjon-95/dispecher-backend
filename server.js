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

// ── Middleware ──
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

// ── SECURITY MIDDLEWARE ──
app.use(helmetConfig)           // HTTP security headers
app.use(extraHeaders)           // Qo'shimcha headerlar
app.use(globalLimiter)          // Rate limiting
app.use(mongoSanitizeConfig)    // NoSQL injection himoya
app.use(xssClean())             // XSS himoya
app.use(sanitizeBody)           // Input sanitization
app.use(securityLog)            // Shubhali so'rovlar log
app.use(ipGuard)                // IP blacklist
app.use(express.json())
app.use(morgan('dev'))

// ── Socket.IO ──
global.__io = io  // accessible from routes

io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id)

  // Admin panel joins 'admin' room
  socket.on('join:admin', () => {
    socket.join('admin')
    console.log(`👤 Admin joined: ${socket.id}`)
  })

  // Driver WebApp can also connect via socket
  socket.on('driver:location-update', async (data) => {
    try {
      const cache = require('./redis/cache')
      const key   = `driver:live:${data.telegramId}`
      const payload = { ...data, online: true, updatedAt: new Date().toISOString() }
      await cache.set(key, payload, 60)
      // Broadcast to all admins
      io.to('admin').emit('driver:live-location', payload)
    } catch(e) {}
  })

  socket.on('disconnect', () => console.log('🔌 Disconnected:', socket.id))
})
app.set('io', io)  // routes ichida ishlatish uchun

// ── MongoDB ──
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/dispecher')

/* ── Startup: .env dan Settings DB ga sync ── */
mongoose.connection.once('open', async () => {
  try {
    const { Settings } = require('./models')
    const tgKeys = ['BOT_TOKEN','BOT_USERNAME','ADMIN_CHAT_ID','WEBAPP_URL']
    
    for (const key of tgKeys) {
      if (!process.env[key]) continue
      // Faqat DB da bo'lmasa yozing (DB ustunlik qiladi)
      const exists = await Settings.findOne({ key })
      if (!exists || !exists.value) {
        await Settings.findOneAndUpdate(
          { key },
          { $set: { key, value: process.env[key] } },
          { upsert: true }
        )
        console.log(`✅ .env → DB: ${key} saqlandi`)
      }
    }
  } catch(e) { console.error('Settings sync error:', e.message) }
})
  .then(async () => {
    console.log('✅ MongoDB connected')
    // Cache warmup
    try {
      const { warmup } = require('./redis/cacheMiddleware')
      const models = require('./models')
      await warmup(models)
    } catch(e) { console.warn('Cache warmup:', e.message) }
  })
  .catch(e => console.error('❌ MongoDB:', e.message))

// ── Redis status ──
const cache = require('./redis/cache')
setTimeout(() => {
  console.log(`📦 Cache: ${cache.status()}`)
}, 2000)

// ── Routes ──
app.use('/api/auth',        R.authR)
app.use('/api/orders',      auth, R.ordersR)
app.use('/api/order-items', R.orderItemsR)
app.use('/api/prices',      R.pricesR)
app.use('/api/delivery',    R.deliveryR)
app.use('/api/pickup',      R.pickupR)
app.use('/api/employees',   auth, R.employeesR)
app.use('/api/drivers',     R.driversR)
app.use('/api/customers',   R.customersR)
app.use('/api/finance',     auth, R.financeR)
app.use('/api/salary',      R.salaryR)
app.use('/api/settings',    R.settingsR)
app.use('/api/archive',     R.archiveR)
app.use('/api/dashboard',   R.dashR)
app.use('/api/driver',           R.driverLiveR)
app.use('/api/telegram-settings', R.telegramSettingsR)
app.use('/api/sms-settings',      R.smsSettingsR)
app.use('/api/home-service',      R.homeServiceR)
app.use('/api/attendance',        R.attendanceR)
app.use('/api/salary-payments',   R.salaryPaymentsR)
app.use('/api/bot',         R.botR)

// ── Health ──
app.head('/health', (_, res) => res.sendStatus(200))

// Driver live locations (from bot GPS)
app.get('/api/driver/live-locations', async (req, res) => {
  try {
    const { getAllLiveLocations } = require('./bot/index')
    const locs = await getAllLiveLocations()
    res.json(locs)
  } catch(e) {
    // Fallback: return empty if bot not running
    res.json([])
  }
})
app.get('/health', (_, res) => res.json({
  status: 'ok',
  time:   new Date().toISOString(),
  cache:  cache.status(),
}))

app.use((_, res) => res.status(404).json({ error: 'Route topilmadi' }))
app.use((err, req, res, next) => { console.error(err.stack); res.status(500).json({ error: err.message }) })

const PORT = process.env.PORT || 5000
server.listen(PORT, () => {
  console.log(`🚀 Server: http://localhost:${PORT}`)
  console.log(`🤖 Bot API: http://localhost:${PORT}/api/bot`)
  console.log(`📊 Dashboard: http://localhost:${PORT}/api/dashboard/stats`)
})

module.exports = { app, io }
