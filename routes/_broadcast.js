'use strict'
/**
 * routes/_broadcast.js
 * Markazlashtirilgan real-time broadcast helper.
 *
 * Har qanday write (create/update/delete) amalidan keyin
 * barcha ulangan admin clientlarga Socket.IO orqali xabar yuboradi.
 * Frontend buni `bus.on('refresh:<type>', ...)` orqali tinglaydi
 * va shu sahifani qayta yuklaydi — to'liq sahifa reload kerak emas.
 *
 * Ishlatish:
 *   const { broadcast, withBroadcast } = require('./_broadcast')
 *   router.post('/', withBroadcast('home-service'), handler)
 *   // yoki qo'lda:
 *   broadcast('orders')
 */

function broadcast(type, extra) {
  try {
    if (global.__io) global.__io.to('admin').emit('data:update', { type, ...extra })
  } catch (e) {
    console.warn('broadcast xato:', e.message)
  }
}

/** Express middleware — javob muvaffaqiyatli bo'lsa avtomatik broadcast qiladi */
function withBroadcast(type) {
  return (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) broadcast(type)
    })
    next()
  }
}

module.exports = { broadcast, withBroadcast }
