'use strict'
require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

const TelegramBot    = require('node-telegram-bot-api').default
                    || require('node-telegram-bot-api')
const mongoose       = require('mongoose')
const { Customer, Order }  = require('../models')
const { invalidateCache }  = require('../redis/cacheMiddleware')
const { broadcast }        = require('../routes/_broadcast')

const TOKEN = process.env.CUSTOMER_BOT_TOKEN
if (!TOKEN) {
  console.log('ℹ️  CUSTOMER_BOT_TOKEN yo\'q — mijoz boti ishlamaydi')
  module.exports = { bot: null }
  return
}

const bot = new TelegramBot(TOKEN, { polling: false })
console.log('🤖 Mijoz boti ishga tushdi...')

// MongoDB ulangandan keyin polling
async function start() {
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 20000,
        bufferCommands: false,
      })
    }
    bot.startPolling({ interval: 300, params: { timeout: 10 } })
    console.log('✅ Mijoz boti polling boshlandi')
  } catch (e) {
    console.error('❌ Mijoz bot MongoDB:', e.message)
    setTimeout(start, 5000)
  }
}
start()

// Session: { chatId: 'cust_loc:orderId:custId' }
const sessions = {}

async function safeSend(chatId, text, opts = {}) {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opts })
  } catch (e) {
    console.error(`[CustomerBot] SEND ERR [${chatId}]:`, e.message)
  }
}

// ── /start ──
bot.onText(/\/start(.*)/, async msg => {
  const chatId = String(msg.chat.id)
  const param  = (msg.text || '').replace('/start', '').trim()

  // Deep link: cust_loc_ORDERID_CUSTID
  if (param.startsWith('cust_loc_')) {
    const parts   = param.replace('cust_loc_', '').split('_')
    const orderId = parts[0] || ''
    const custId  = parts[1] || ''
    sessions[chatId] = `${orderId}:${custId}`

    // Mijozni Telegram ID bilan bog'laymiz
    if (custId) {
      await Customer.findByIdAndUpdate(custId, { tgChatId: chatId }).catch(() => {})
    }

    return safeSend(chatId,
      `👋 *Tartib CRM — Gilam yuvish xizmati*\n\n` +
      `Siz buyurtma bergansiz. Shafyorimiz kelib olib ketishi uchun\n` +
      `*manzilingizni* yuborishingiz kerak.\n\n` +
      `Pastdagi tugmani bosing 👇`,
      {
        reply_markup: {
          keyboard: [[
            { text: '📍 Manzilimni yuborish', request_location: true }
          ]],
          resize_keyboard: true,
          one_time_keyboard: true,
        }
      }
    )
  }

  // Deep link yo'q — oddiy /start
  safeSend(chatId,
    `👋 *Tartib CRM — Gilam yuvish xizmati*\n\n` +
    `Bu bot manzil olish uchun ishlatiladi.\n` +
    `Agar buyurtma bergansiz, admindan havolani so'rang.`
  )
})

// ── Joylashuv keldi ──
bot.on('message', async msg => {
  const chatId = String(msg.chat.id)
  if (!msg.location) return
  if (!sessions[chatId]) return

  const [orderId, custId] = sessions[chatId].split(':')
  const { latitude, longitude } = msg.location

  try {
    // Customer ga saqlash
    if (custId) {
      await Customer.findByIdAndUpdate(custId, {
        lat: latitude, lon: longitude, locationSaved: true,
      })
    }
    // Order ga ham saqlash
    if (orderId) {
      await Order.findByIdAndUpdate(orderId, { lat: latitude, lon: longitude })
    }
    await invalidateCache(['customers', 'orders', 'dashboard'])
    broadcast('customers')
    broadcast('orders')

    delete sessions[chatId]

    await safeSend(chatId,
      `✅ *Manzilingiz saqlandi!*\n\n` +
      `📐 ${latitude.toFixed(5)}, ${longitude.toFixed(5)}\n\n` +
      `Shafyorimiz tez orada yo'l oladi. Rahmat! 🙏`,
      { reply_markup: { remove_keyboard: true } }
    )

    console.log(`[CustomerBot] Manzil saqlandi: orderId=${orderId}, ${latitude},${longitude}`)
  } catch (e) {
    console.error('[CustomerBot] saqlash xato:', e.message)
    safeSend(chatId, '⚠️ Manzilni saqlashda xato. Qayta urinib ko\'ring.')
  }
})

// Error handlers
bot.on('polling_error', err => console.error('[CustomerBot] POLLING ERROR:', err.message))
bot.on('error',         err => console.error('[CustomerBot] BOT ERROR:', err.message))

// ── Tashqaridan chaqirish uchun: mijozga location so'rash xabari
async function sendLocationRequest(tgChatId, orderId, custId) {
  if (!bot || !tgChatId) return false
  try {
    await safeSend(tgChatId,
      `📍 *Tartib CRM — Gilam yuvish*\n\n` +
      `Shafyorimiz gilam(lar)ingizni olib ketishi uchun\n` +
      `*manzilingizni* yuborishingiz kerak.\n\n` +
      `Pastdagi tugmani bosing 👇`,
      {
        reply_markup: {
          keyboard: [[{ text: '📍 Manzilimni yuborish', request_location: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        }
      }
    )
    sessions[tgChatId] = `${orderId}:${custId}`
    return true
  } catch (e) {
    console.error('[CustomerBot] sendLocationRequest:', e.message)
    return false
  }
}

module.exports = { bot, sendLocationRequest }
