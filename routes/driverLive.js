// =============================================
//  DRIVER LIVE LOCATION ROUTES
//  POST /api/driver/live-location  — WebApp pushes GPS
//  GET  /api/driver/live-locations — Admin gets all online drivers
//  GET  /api/driver/live-location/:telegramId — single driver
//  POST /api/driver/offline        — mark driver offline
// =============================================
const router = require('express').Router()
const cache  = require('../redis/cache')

// Redis key pattern: driver:live:{telegramId}
const REDIS_KEY  = id => `driver:live:${id}`
const REDIS_ALL  = 'driver:live:*'
const TTL_SECS   = 60   // 60 sekund — yangi signal kelmasa offline

/* ── Validate Telegram initData (basic) ── */
function validateInitData(initData, telegramId) {
  // Production'da crypto.createHmac bilan to'liq validate qilinadi
  // Hozircha telegramId mavjudligini tekshiramiz
  if (!telegramId) return false
  return true
}

/* ─────────────────────────────────────────
   POST /api/driver/live-location
   WebApp har 10 sekundda shu endpointni chaqiradi
───────────────────────────────────────── */
router.post('/live-location', async (req, res) => {
  try {
    const { telegramId, latitude, longitude, speed, heading, accuracy, initData } = req.body

    if (!validateInitData(initData, telegramId)) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    if (!latitude || !longitude) {
      return res.status(400).json({ error: 'latitude va longitude kerak' })
    }

    const payload = {
      telegramId:  String(telegramId),
      driverName:  req.body.driverName || '',
      latitude:    parseFloat(latitude),
      longitude:   parseFloat(longitude),
      speed:       speed    ? parseFloat(speed)    : null,
      heading:     heading  ? parseFloat(heading)  : null,
      accuracy:    accuracy ? parseFloat(accuracy) : null,
      updatedAt:   new Date().toISOString(),
      online:      true,
    }

    // Redis ga saqlash (TTL: 60 sekund)
    await cache.set(REDIS_KEY(telegramId), payload, TTL_SECS)

    // Socket.IO orqali admin panelga real-time yuborish
    const io = req.app.get('io')
    if (io) {
      io.to('admin').emit('driver:live-location', payload)
    }

    res.json({ ok: true, ttl: TTL_SECS })
  } catch (e) {
    console.error('live-location error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

/* ─────────────────────────────────────────
   GET /api/driver/live-locations
   Admin barcha online shafyorlarni oladi
───────────────────────────────────────── */
router.get('/live-locations', async (req, res) => {
  try {
    const keys    = await cache.keys(REDIS_ALL)
    const drivers = []

    for (const key of keys) {
      const data = await cache.get(key)
      if (data && data.online) {
        // TTL check: agar updatedAt dan 60s o'tgan bo'lsa offline
        const age = Date.now() - new Date(data.updatedAt).getTime()
        if (age < TTL_SECS * 1000) {
          drivers.push(data)
        }
      }
    }

    res.json(drivers)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* ─────────────────────────────────────────
   GET /api/driver/live-location/:telegramId
───────────────────────────────────────── */
router.get('/live-location/:telegramId', async (req, res) => {
  try {
    const data = await cache.get(REDIS_KEY(req.params.telegramId))
    if (!data) return res.json({ online: false })
    const age = Date.now() - new Date(data.updatedAt).getTime()
    res.json({ ...data, online: age < TTL_SECS * 1000 })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* ─────────────────────────────────────────
   POST /api/driver/offline
   Shafyor tracking'ni to'xtatganda
───────────────────────────────────────── */
router.post('/offline', async (req, res) => {
  try {
    const { telegramId } = req.body
    if (!telegramId) return res.status(400).json({ error: 'telegramId kerak' })

    await cache.del(REDIS_KEY(telegramId))

    const io = req.app.get('io')
    if (io) {
      io.to('admin').emit('driver:offline', { telegramId })
    }

    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
