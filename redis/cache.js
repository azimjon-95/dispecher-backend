'use strict'
/**
 * REDIS SERVICE — production-grade
 * Fallback: in-memory LRU-style store
 */
const Redis = require('ioredis')

let redis    = null
let useMemory = false
const memStore = new Map()
const MAX_MEM  = 1000  // max keys in memory

function getRedis() {
  if (redis) return redis
  try {
    redis = new Redis({
      host:          process.env.REDIS_HOST || '127.0.0.1',
      port:          parseInt(process.env.REDIS_PORT) || 6379,
      password:      process.env.REDIS_PASSWORD || undefined,
      db:            parseInt(process.env.REDIS_DB) || 0,
      enableReadyCheck: true,
      maxRetriesPerRequest: 2,
      retryStrategy: (times) => {
        if (times > 4) { useMemory = true; return null }
        return Math.min(times * 300, 3000)
      },
      lazyConnect: true,
      connectTimeout: 5000,
    })
    redis.on('connect', () => { console.log('✅ Redis connected'); useMemory = false })
    redis.on('ready',   () => { useMemory = false })
    redis.on('error',   () => { useMemory = true })
    redis.on('close',   () => { useMemory = true })
    redis.connect().catch(() => { useMemory = true })
  } catch {
    useMemory = true
  }
  return redis
}
getRedis()

/* ── Memory LRU eviction ── */
function memEvict() {
  if (memStore.size > MAX_MEM) {
    const firstKey = memStore.keys().next().value
    memStore.delete(firstKey)
  }
}

const cache = {
  /* GET */
  async get(key) {
    if (useMemory) {
      const item = memStore.get(key)
      if (!item) return null
      if (item.exp && item.exp < Date.now()) { memStore.delete(key); return null }
      return item.val
    }
    try {
      const v = await redis.get(key)
      return v ? JSON.parse(v) : null
    } catch { return null }
  },

  /* SET with TTL */
  async set(key, value, ttlSeconds = 300) {
    const val = JSON.stringify(value)
    if (useMemory) {
      memEvict()
      memStore.set(key, { val: value, exp: Date.now() + ttlSeconds * 1000 })
      return
    }
    try { await redis.set(key, val, 'EX', ttlSeconds) } catch {}
  },

  /* SET only if not exists (atomic) */
  async setnx(key, value, ttlSeconds = 300) {
    const val = JSON.stringify(value)
    if (useMemory) {
      if (memStore.has(key)) return false
      memStore.set(key, { val: value, exp: Date.now() + ttlSeconds * 1000 })
      return true
    }
    try {
      const res = await redis.set(key, val, 'EX', ttlSeconds, 'NX')
      return res === 'OK'
    } catch { return false }
  },

  /* DELETE */
  async del(...keys) {
    const flat = keys.flat().filter(Boolean)
    if (!flat.length) return
    if (useMemory) { flat.forEach(k => memStore.delete(k)); return }
    try { await redis.del(...flat) } catch {}
  },

  /* INCR (counter) */
  async incr(key, ttlSeconds = 3600) {
    if (useMemory) {
      const item = memStore.get(key)
      const val  = (item?.val || 0) + 1
      memStore.set(key, { val, exp: Date.now() + ttlSeconds * 1000 })
      return val
    }
    try {
      const v = await redis.incr(key)
      if (v === 1) await redis.expire(key, ttlSeconds)
      return v
    } catch { return 0 }
  },

  /* HASH operations */
  async hset(key, field, value) {
    if (useMemory) {
      const h = memStore.get(key)?.val || {}
      h[field] = value
      memStore.set(key, { val: h })
      return
    }
    try { await redis.hset(key, field, JSON.stringify(value)) } catch {}
  },

  async hget(key, field) {
    if (useMemory) { return memStore.get(key)?.val?.[field] ?? null }
    try { const v = await redis.hget(key, field); return v ? JSON.parse(v) : null } catch { return null }
  },

  async hgetall(key) {
    if (useMemory) return memStore.get(key)?.val || {}
    try {
      const h = await redis.hgetall(key)
      if (!h) return {}
      const res = {}
      for (const [k, v] of Object.entries(h)) { try { res[k] = JSON.parse(v) } catch { res[k] = v } }
      return res
    } catch { return {} }
  },

  async hdel(key, ...fields) {
    if (useMemory) {
      const h = memStore.get(key)?.val || {}
      fields.forEach(f => delete h[f])
      memStore.set(key, { val: h })
      return
    }
    try { await redis.hdel(key, ...fields) } catch {}
  },

  /* LIST (queue) */
  async lpush(key, ...values) {
    if (useMemory) {
      const arr = memStore.get(key)?.val || []
      values.forEach(v => arr.unshift(v))
      memStore.set(key, { val: arr.slice(0, 500) })
      return arr.length
    }
    try { return await redis.lpush(key, ...values.map(v => JSON.stringify(v))) } catch { return 0 }
  },

  async lrange(key, start = 0, end = -1) {
    if (useMemory) {
      const arr = memStore.get(key)?.val || []
      return end === -1 ? arr.slice(start) : arr.slice(start, end + 1)
    }
    try {
      const items = await redis.lrange(key, start, end)
      return items.map(i => { try { return JSON.parse(i) } catch { return i } })
    } catch { return [] }
  },

  async llen(key) {
    if (useMemory) return memStore.get(key)?.val?.length || 0
    try { return await redis.llen(key) } catch { return 0 }
  },

  /* KEYS pattern */
  async keys(pattern) {
    if (useMemory) {
      const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
      return [...memStore.keys()].filter(k => re.test(k))
    }
    try { return await redis.keys(pattern) } catch { return [] }
  },

  /* TTL check */
  async ttl(key) {
    if (useMemory) {
      const item = memStore.get(key)
      if (!item?.exp) return -1
      return Math.max(0, Math.round((item.exp - Date.now()) / 1000))
    }
    try { return await redis.ttl(key) } catch { return -1 }
  },

  /* EXISTS */
  async exists(key) {
    if (useMemory) {
      const item = memStore.get(key)
      if (!item) return false
      if (item.exp && item.exp < Date.now()) { memStore.delete(key); return false }
      return true
    }
    try { return (await redis.exists(key)) === 1 } catch { return false }
  },

  /* EXPIRE (update TTL) */
  async expire(key, ttlSeconds) {
    if (useMemory) {
      const item = memStore.get(key)
      if (item) item.exp = Date.now() + ttlSeconds * 1000
      return
    }
    try { await redis.expire(key, ttlSeconds) } catch {}
  },

  /* FLUSH all (admin use) */
  async flushdb() {
    if (useMemory) { memStore.clear(); return }
    try { await redis.flushdb() } catch {}
  },

  /* Stats */
  status:   () => useMemory ? 'memory' : 'redis',
  memSize:  () => memStore.size,
  isReady:  () => !useMemory,
}

// Compat aliases
cache.setHash    = cache.hset
cache.getHash    = cache.hget
cache.getAllHash  = cache.hgetall

module.exports = cache
