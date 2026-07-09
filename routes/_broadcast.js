'use strict'
/**
 * routes/_broadcast.js
 *
 * Broadcast strategiyasi:
 *   1. Server processida (__io mavjud) → Socket.IO to('admin').emit
 *   2. Bot processida (__io yo'q) → HTTP POST /api/internal/broadcast
 *      (server o'zi Socket.IO ga uzatadi)
 */

const http = require('http')

// Internal broadcast endpoint — bot processidan chaqiriladi
function broadcastViaHttp(type, extra = {}) {
  try {
    const PORT    = process.env.PORT || 5000
    const body    = JSON.stringify({ type, ...extra })
    const options = {
      hostname: '127.0.0.1',
      port:     PORT,
      path:     '/api/internal/broadcast',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-internal-key': process.env.INTERNAL_KEY || 'tartib_internal',
      },
    }
    const req = http.request(options)
    req.on('error', () => {}) // silent
    req.write(body)
    req.end()
  } catch {}
}

function broadcast(type, extra) {
  try {
    if (global.__io) {
      // Server process — to'g'ridan Socket.IO
      global.__io.to('admin').emit('data:update', { type, ...extra })
    } else {
      // Bot process — HTTP orqali server'ga
      broadcastViaHttp(type, extra)
    }
  } catch (e) {
    console.warn('broadcast xato:', e.message)
  }
}

function withBroadcast(type) {
  return (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) broadcast(type)
    })
    next()
  }
}

module.exports = { broadcast, withBroadcast }
