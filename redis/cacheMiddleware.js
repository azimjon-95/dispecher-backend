'use strict'
/**
 * REDIS CACHE MIDDLEWARE
 * 
 * Strategiya:
 *  GET  /api/orders  → cache dan qaytaradi (TTL 30s)
 *  POST /api/orders  → cache ni invalidate qiladi
 *  PUT  /api/orders/:id → cache ni invalidate qiladi
 *  DELETE → cache ni invalidate qiladi
 * 
 * Cache key: method + path + query
 * Cache invalidation: prefix bo'yicha (masalan "orders:" barcha order cache lari)
 */

const cache = require('./cache')

/* ── TTL sozlamalari (sekundlarda) ── */
const TTL = {
  orders:          30,   // tez-tez o'zgaradi
  employees:       120,  // kamroq o'zgaradi
  drivers:         60,
  customers:       120,
  finance:         60,
  salary:          120,
  prices:          600,  // nadir o'zgaradi
  delivery:        20,   // juda tez-tez
  pickup:          20,
  'order-items':   20,
  attendance:      30,
  'salary-payments': 60,
  'home-service':  60,
  'dashboard':     30,
  archive:         300,
  default:         60,
}

/* ── Cache prefix (invalidation uchun) ── */
function getPrefix(path) {
  const parts = path.replace('/api/', '').split('/')
  return parts[0] || 'misc'
}

/* ── Cache key generator ── */
function makeKey(req) {
  const prefix = getPrefix(req.path)
  const query  = JSON.stringify(req.query || {})
  const path   = req.path
  return `api:${prefix}:${path}:${query}`
}

/* ── GET middleware (cache-first) ── */
function cacheGet(customTTL) {
  return async (req, res, next) => {
    if (req.method !== 'GET') return next()
    
    const key = makeKey(req)
    try {
      const cached = await cache.get(key)
      if (cached !== null) {
        res.set('X-Cache', 'HIT')
        res.set('X-Cache-Key', key.slice(0, 80))
        return res.json(cached)
      }
    } catch {}

    // Override res.json to cache the response
    const origJson = res.json.bind(res)
    res.json = async (data) => {
      res.set('X-Cache', 'MISS')
      const prefix = getPrefix(req.path)
      const ttl    = customTTL || TTL[prefix] || TTL.default
      try {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          await cache.set(key, data, ttl)
        }
      } catch {}
      return origJson(data)
    }
    next()
  }
}

/* ── Invalidation middleware (POST/PUT/DELETE) ── */
function invalidateCache(prefixes) {
  return async (req, res, next) => {
    if (req.method === 'GET') return next()

    const origJson = res.json.bind(res)
    res.json = async (data) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        // Invalidate related caches
        const toInvalidate = prefixes || [getPrefix(req.path)]
        for (const prefix of toInvalidate) {
          try {
            const keys = await cache.keys(`api:${prefix}:*`)
            if (keys.length > 0) await cache.del(...keys)
            // Also invalidate dashboard (it aggregates everything)
            const dashKeys = await cache.keys('dashboard:*')
            if (dashKeys.length > 0) await cache.del(...dashKeys)
          } catch {}
        }
      }
      return origJson(data)
    }
    next()
  }
}

/* ── Bulk invalidation helper ── */
async function invalidatePrefix(prefix) {
  try {
    const keys = await cache.keys(`api:${prefix}:*`)
    if (keys.length > 0) await cache.del(...keys)
  } catch {}
}

/* ── Warmup: preload frequently accessed data ── */
async function warmup(models) {
  const { Order, Employee, Driver, Customer, Finance, Price } = models
  const tasks = [
    { key:'api:prices:/api/prices:{}',     fn: () => Price.find({ deletedAt:{$exists:false} }).lean(),    ttl: TTL.prices },
    { key:'api:drivers:/api/drivers:{}',   fn: () => Driver.find({ deletedAt:{$exists:false} }).lean(),   ttl: TTL.drivers },
    { key:'api:employees:/api/employees:{}', fn: () => Employee.find({ status:'active' }).lean(),          ttl: TTL.employees },
  ]
  let warmed = 0
  for (const task of tasks) {
    try {
      const existing = await cache.get(task.key)
      if (!existing) {
        const data = await task.fn()
        await cache.set(task.key, data, task.ttl)
        warmed++
      }
    } catch {}
  }
  if (warmed > 0) console.log(`🔥 Cache warmup: ${warmed} ta key yozildi`)
}

module.exports = { cacheGet, invalidateCache, invalidatePrefix, warmup, TTL, makeKey }
