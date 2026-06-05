require('dotenv').config()
const express   = require('express')
const mongoose  = require('mongoose')
const cors      = require('cors')
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
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:3000', credentials: true }))
app.use(express.json())
app.use(morgan('dev'))

// ── Socket.IO ──
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
  .then(() => console.log('✅ MongoDB connected'))
  .catch(e => console.error('❌ MongoDB:', e.message))

// ── Redis status ──
const cache = require('./redis/cache')
setTimeout(() => {
  console.log(`📦 Cache: ${cache.status()}`)
}, 2000)

// ── Routes ──
app.use('/api/auth',        R.authR)
app.use('/api/orders',      R.ordersR)
app.use('/api/order-items', R.orderItemsR)
app.use('/api/prices',      R.pricesR)
app.use('/api/delivery',    R.deliveryR)
app.use('/api/pickup',      R.pickupR)
app.use('/api/employees',   R.employeesR)
app.use('/api/drivers',     R.driversR)
app.use('/api/customers',   R.customersR)
app.use('/api/finance',     R.financeR)
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
