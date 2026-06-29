// routes/telegramSettings.js
// Telegram sozlamalari faqat .env dan o'qiladi — DB ga yozilmaydi
const router = require('express').Router()

/* ── GET /api/telegram-settings — faqat status ko'rsatadi ── */
router.get('/', (req, res) => {
  res.json({
    _botActive:   !!process.env.BOT_TOKEN,
    BOT_USERNAME: process.env.BOT_USERNAME || '',
    WEBAPP_URL:   process.env.WEBAPP_URL   || '',
    // Token va ADMIN_CHAT_ID xavfsizlik uchun qaytarilmaydi
  })
})

module.exports = router
