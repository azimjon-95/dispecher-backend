'use strict'
/**
 * services/gpsReminder.js
 * Har 60 soniyada ishlaydigan cron.
 * Ishlayotgan shafyor WebApp ochiq bo'lmasa — botda xabar.
 *
 * Qoidalar:
 *  1. Ish boshlagach 2 daqiqa — WebApp ochilmagan → bot xabar
 *  2. WebApp yopilgach 4 daqiqa — qayta ochilmagan → bot xabar
 *  3. Har 15 daqiqada bir martadan ko'p xabar yo'q (spam himoya)
 */
const { Driver } = require('../models')

const WEBAPP_URL       = process.env.WEBAPP_URL || 'https://demo.tartibcrm.uz/driver-app'
const FIRST_REMIND_MS  = 2  * 60 * 1000   // ish boshlagach 2 daqiqa
const REOPEN_REMIND_MS = 4  * 60 * 1000   // webapp yopilgach 4 daqiqa
const COOLDOWN_MS      = 15 * 60 * 1000   // 15 daqiqada bir marta

let _interval = null

function start() {
  if (_interval) return
  _interval = setInterval(checkDrivers, 60_000)
  console.log('✅ GPS Reminder boshlandi (har 60s)')
}

function stop() {
  if (_interval) { clearInterval(_interval); _interval = null }
}

async function checkDrivers() {
  try {
    const now     = Date.now()
    const drivers = await Driver.find({
      isWorking: true,
      tgChatId:  { $exists: true, $ne: '' },
      deletedAt: { $exists: false },
    }).select('name tgChatId workStartedAt webappOpenedAt webappClosedAt gpsReminderAt').lean()

    for (const drv of drivers) {
      await checkOne(drv, now)
    }
  } catch (e) {
    console.error('gpsReminder xato:', e.message)
  }
}

async function checkOne(drv, now) {
  const bot = global.__bot
  if (!bot) return

  // Cooldown tekshiruvi
  if (drv.gpsReminderAt && (now - new Date(drv.gpsReminderAt).getTime()) < COOLDOWN_MS) return

  const workStart = drv.workStartedAt  ? new Date(drv.workStartedAt).getTime()  : 0
  const appOpened = drv.webappOpenedAt ? new Date(drv.webappOpenedAt).getTime()  : 0
  const appClosed = drv.webappClosedAt ? new Date(drv.webappClosedAt).getTime()  : 0

  let reason = ''

  if (!appOpened && workStart && (now - workStart) >= FIRST_REMIND_MS) {
    reason = 'Ish boshladingiz, lekin GPS hali yoqilmagan'
  } else if (appClosed && appClosed > appOpened && (now - appClosed) >= REOPEN_REMIND_MS) {
    reason = 'GPS tracking yopildi'
  }

  if (!reason) return

  // Bot xabari — inline WebApp tugma bilan
  try {
    await bot.sendMessage(drv.tgChatId,
      `⚠️ *GPS kuzatuv o'chirilgan!*\n\n` +
      `${reason}.\n\n` +
      `CRM xaritasida harakatlaringiz ko'rinmayapti.\n` +
      `Pastdagi tugmani bosib GPS ni yoqing 👇`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '📡 GPS Yoqish', web_app: { url: WEBAPP_URL } },
          ]],
        },
      }
    )
    await Driver.findByIdAndUpdate(drv._id, { gpsReminderAt: new Date() })
    console.log(`📡 GPS eslatma: ${drv.name} — "${reason}"`)
  } catch (e) {
    console.error('gpsReminder bot xabar xato:', e.message)
  }
}

module.exports = { start, stop }
