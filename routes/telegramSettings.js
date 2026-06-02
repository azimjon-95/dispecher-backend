// routes/telegramSettings.js
// Telegram konfiguratsiya — DB da saqlanadi, .env fallback
const router   = require('express').Router()
const { Settings } = require('../models')
const cache    = require('../redis/cache')

const TG_KEYS = ['BOT_TOKEN','BOT_USERNAME','ADMIN_CHAT_ID','WEBAPP_URL']
const CACHE_K = 'settings:telegram'

/* ── GET /api/telegram-settings ── */
router.get('/', async (req, res) => {
  try {
    const cached = await cache.get(CACHE_K)
    if (cached) return res.json(cached)

    const rows = await Settings.find({ key: { $in: TG_KEYS } }).lean()
    const result = {}
    TG_KEYS.forEach(k => {
      const row = rows.find(r => r.key === k)
      // DB da bo'lsa DB, yo'qsa .env dan
      result[k] = row?.value || process.env[k] || ''
    })

    await cache.set(CACHE_K, result, 300)
    res.json(result)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

/* ── PUT /api/telegram-settings ── */
router.put('/', async (req, res) => {
  try {
    const body = req.body || {}
    const updates = []

    for (const key of TG_KEYS) {
      if (body[key] !== undefined) {
        await Settings.findOneAndUpdate(
          { key },
          { $set: { key, value: body[key] } },
          { upsert: true, new: true }
        )
        // Also update process.env for current session
        if (body[key]) process.env[key] = body[key]
        updates.push(key)
      }
    }

    await cache.del(CACHE_K)

    // Reinit bot if token changed
    if (body.BOT_TOKEN || body.BOT_USERNAME) {
      try {
        const botModule = require('../bot/index')
        if (typeof botModule.stopBot === 'function') botModule.stopBot()
        if (body.BOT_TOKEN && typeof botModule.initBot === 'function') {
          setTimeout(() => botModule.initBot(), 1000)
        }
      } catch {}
    }

    res.json({ ok: true, updated: updates })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

/* ── POST /api/telegram-settings/test ── */
router.post('/test', async (req, res) => {
  try {
    const { chatId } = req.body
    const rows   = await Settings.find({ key: { $in: ['BOT_TOKEN','ADMIN_CHAT_ID'] } }).lean()
    const token  = rows.find(r=>r.key==='BOT_TOKEN')?.value  || process.env.BOT_TOKEN
    const target = chatId || rows.find(r=>r.key==='ADMIN_CHAT_ID')?.value || process.env.ADMIN_CHAT_ID

    if (!token)  return res.status(400).json({ error: 'BOT_TOKEN kiritilmagan' })
    if (!target) return res.status(400).json({ error: 'ADMIN_CHAT_ID kiritilmagan' })

    const TelegramBot = require('node-telegram-bot-api')
    const bot = new TelegramBot(token, { polling: false })
    await bot.sendMessage(target, '✅ *Dispecher Bot* — Test xabari muvaffaqiyatli yetdi!', { parse_mode:'Markdown' })

    res.json({ ok: true, message: 'Test xabari yuborildi ✅' })
  } catch(e) { res.status(500).json({ error: 'Xato: ' + e.message }) }
})

module.exports = router
