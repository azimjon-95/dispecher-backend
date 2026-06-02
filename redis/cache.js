// =============================================
//  REDIS SERVICE
//  Agar Redis mavjud bo'lmasa — in-memory cache
// =============================================
const Redis = require('ioredis')

let redis = null
let useMemory = false
const memStore = new Map()

function getRedis() {
  if (redis) return redis
  try {
    redis = new Redis({
      host:     process.env.REDIS_HOST || '127.0.0.1',
      port:     parseInt(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      db:       parseInt(process.env.REDIS_DB) || 0,
      retryStrategy: (times) => {
        if (times > 3) {
          console.warn('⚠️  Redis ulanmadi — in-memory cache ishlatiladi')
          useMemory = true
          return null
        }
        return Math.min(times * 200, 2000)
      },
      lazyConnect: true,
    })
    redis.on('connect',  () => { console.log('✅ Redis connected'); useMemory = false })
    redis.on('error',    (e) => { useMemory = true })
    redis.connect().catch(() => { useMemory = true })
  } catch {
    useMemory = true
  }
  return redis
}

getRedis()

// ── Public API ──
const cache = {
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

  async set(key, value, ttlSeconds = 300) {
    const val = JSON.stringify(value)
    if (useMemory) {
      memStore.set(key, { val: value, exp: Date.now() + ttlSeconds * 1000 })
      return
    }
    try { await redis.set(key, val, 'EX', ttlSeconds) } catch {}
  },

  async del(...keys) {
    if (useMemory) { keys.forEach(k => memStore.delete(k)); return }
    try { await redis.del(...keys) } catch {}
  },

  async setHash(key, field, value) {
    if (useMemory) {
      const h = memStore.get(key)?.val || {}
      h[field] = value
      memStore.set(key, { val: h })
      return
    }
    try { await redis.hset(key, field, JSON.stringify(value)) } catch {}
  },

  async getHash(key, field) {
    if (useMemory) {
      const h = memStore.get(key)?.val || {}
      return h[field] ?? null
    }
    try {
      const v = await redis.hget(key, field)
      return v ? JSON.parse(v) : null
    } catch { return null }
  },

  async getAllHash(key) {
    if (useMemory) return memStore.get(key)?.val || {}
    try {
      const h = await redis.hgetall(key)
      if (!h) return {}
      const res = {}
      for (const [k, v] of Object.entries(h)) { res[k] = JSON.parse(v) }
      return res
    } catch { return {} }
  },

  async keys(pattern) {
    if (useMemory) {
      const re = new RegExp('^' + pattern.replace('*', '.*') + '$')
      return [...memStore.keys()].filter(k => re.test(k))
    }
    try { return await redis.keys(pattern) } catch { return [] }
  },

  // TTL qolganini olish
  async ttl(key) {
    if (useMemory) {
      const item = memStore.get(key)
      if (!item || !item.exp) return -1
      return Math.max(0, Math.round((item.exp - Date.now()) / 1000))
    }
    try { return await redis.ttl(key) } catch { return -1 }
  },

  status: () => useMemory ? 'memory' : 'redis',
}

module.exports = cache
