'use strict'
/**
 * services/gpsReminder.js
 *
 * Har 60 soniyada ishlaydigan cron — ishlayotgan shafyorlarni
 * tekshiradi va WebApp ochiq bo'lmasa SMS + bot xabar yuboradi.
 *
 * Qoidalar:
 *  1. Shafyor "Ishni boshlash" bossandan 2 daqiqa o'tsa va
 *     WebApp hali ochilmagan bo'lsa → SMS + bot xabar
 *  2. WebApp yopilgandan 4 daqiqa o'tsa va
 *     hali yangi signal kelmagan bo'lsa → SMS + bot xabar
 *  3. SMS har 15 daqiqada bir martadan ko'p yuborilmaydi
 *     (spam oldini olish uchun)
 */
const { Driver } = require('../models')
const { sendSMS } = require('./sms')

const WEBAPP_URL      = process.env.WEBAPP_URL || 'https://demo.tartibcrm.uz/driver-app'
const FIRST_REMIND_MS = 2  * 60 * 1000   // ish boshlagach 2 daqiqa
const REOPEN_REMIND_MS= 4  * 60 * 1000   // webapp yopilgach 4 daqiqa
const SMS_COOLDOWN_MS = 15 * 60 * 1000   // har 15 daqiqada bir marta SMS

let _interval = null

function start() {
  if (_interval) return
  _interval = setInterval(checkDrivers, 60_000)
  console.log('✅ GPS Reminder service boshlandi (har 60s)')
}

function stop() {
  if (_interval) { clearInterval(_interval); _interval = null }
}

async function checkDrivers() {
  try {
    const now      = Date.now()
    const drivers  = await Driver.find({
      isWorking:  true,
      tgChatId:   { $exists: true, $ne: '' },
      deletedAt:  { $exists: false },
    }).select('name phone tgChatId workStartedAt webappOpenedAt webappClosedAt gpsSmsSentAt').lean()

    for (const drv of drivers) {
      await checkOne(drv, now)
    }
  } catch (e) {
    console.error('gpsReminder checkDrivers xato:', e.message)
  }
}

async function checkOne(drv, now) {
  const bot = global.__bot
  if (!bot) return

  // SMS cooldown — oxirgi SMSdan 15 daqiqa o'tmagan bo'lsa skip
  if (drv.gpsSmsSentAt && (now - new Date(drv.gpsSmsSentAt).getTime()) < SMS_COOLDOWN_MS) return

  let shouldSend  = false
  let reason      = ''

  const workStart  = drv.workStartedAt  ? new Date(drv.workStartedAt).getTime()  : 0
  const appOpened  = drv.webappOpenedAt ? new Date(drv.webappOpenedAt).getTime()  : 0
  const appClosed  = drv.webappClosedAt ? new Date(drv.webappClosedAt).getTime()  : 0

  if (!appOpened && workStart && (now - workStart) >= FIRST_REMIND_MS) {
    // Holat 1: Ish boshladi, lekin WebApp hali ochilmagan
    shouldSend = true
    reason     = 'Ish boshlagansiz lekin GPS yoqilmagan'
  } else if (appClosed && (!appOpened || appClosed > appOpened) && (now - appClosed) >= REOPEN_REMIND_MS) {
    // Holat 2: WebApp yopildi va qayta ochilmadi
    shouldSend = true
    reason     = 'GPS tracking yopildi'
  }

  if (!shouldSend) return

  // Bot xabar + inline WebApp tugma
  try {
    await bot.sendMessage(drv.tgChatId,
      `⚠️ *GPS kuzatuv o'chirilgan!*\n\n` +
      `${reason}.\n\n` +
      `CRM xaritasida harakatlaringiz ko'rinmayapti.\n` +
      `Iltimos WebApp ni oching va GPS ni yoqing 👇`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '📡 GPS Yoqish', web_app: { url: WEBAPP_URL } },
          ]],
        },
      }
    )
  } catch (e) {
    console.error('gpsReminder bot xabar xato:', e.message)
  }

  // SMS ham yuborish (agar telefon raqami bo'lsa)
  if (drv.phone) {
    const smsText =
      `Tartib CRM: GPS tracking yopildi. ` +
      `Iltimos botni oching va GPS ni yoqing: ${WEBAPP_URL}`
    await sendSMS(drv.phone, smsText)
  }

  // gpsSmsSentAt yangilash
  await Driver.findByIdAndUpdate(drv._id, { gpsSmsSentAt: new Date() })
  console.log(`📡 GPS eslatma yuborildi: ${drv.name} (${reason})`)
}

module.exports = { start, stop, checkDrivers }
