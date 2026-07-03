'use strict'
require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

const TelegramBot = require('node-telegram-bot-api').default || require('node-telegram-bot-api')
const mongoose    = require('mongoose')

// ─── MongoDB (bot alohida process sifatida ishlaganda kerak) ───
if (mongoose.connection.readyState === 0) {
  mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 20000,
    bufferCommands: false,
  })
    .then(() => console.log('✅ Bot: MongoDB ulandi'))
    .catch(e => console.error('❌ Bot DB:', e.message))
}

const { Driver, Employee, OrderItem, Task, Attendance } = require('../models')
const { advanceOrderItem, syncOrderStats } = require('../services/orderSync')
const { broadcast }       = require('../routes/_broadcast')
const { invalidateCache } = require('../redis/cacheMiddleware')

// ─── Token tekshiruv ───
const TOKEN = process.env.BOT_TOKEN
if (!TOKEN) {
  console.error('❌ BOT_TOKEN topilmadi!')
  process.exit(1)
}

// ─── BOT INSTANCE — bitta, faqat shu yerda ───
const bot = new TelegramBot(TOKEN, {
  polling: {
    interval: 300,
    params: { timeout: 10 },
  }
})

// global.__bot — services/telegram.js shu orqali bot ga yetadi
// require() qilmasdan, circular dependency yo'q
global.__bot = bot

console.log('🚀 Bot ishga tushdi...')

// ─── Helpers ───
const fc    = n => (n || 0).toLocaleString('ru-RU') + " so'm"
const nowT  = () => new Date().toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' })
const today = () => new Date().toISOString().slice(0, 10)

const sessions = {}

async function safeSend(chatId, text, opts = {}) {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opts })
  } catch (e) {
    console.error('SEND ERR [' + chatId + ']:', e.message)
  }
}

// ─── findUser: parallel query ───
async function findUser(chatId) {
  const cid = String(chatId)
  const [driver, worker] = await Promise.all([
    Driver.findOne({ tgChatId: cid }).lean(),
    Employee.findOne({ tgChatId: cid }).lean(),
  ])
  if (driver) return { type: 'driver', doc: driver }
  if (worker) return { type: 'worker', doc: worker }
  return null
}

// ════════════════════════════════
//  /start
// ════════════════════════════════
bot.onText(/\/start/, async msg => {
  const chatId = String(msg.chat.id)
  console.log('START:', chatId)
  try {
    const user = await findUser(chatId)
    if (user) return sendMainMenu(chatId, user)
    sessions[chatId] = { step: 'pin' }
    safeSend(chatId,
      `👋 *Xush kelibsiz — Tartib CRM*\n\n` +
      `Tizimga kirish uchun *4 xonali PIN kodingizni* yuboring.\n` +
      `📌 PIN kodni admindan oling.`,
      { reply_markup: { remove_keyboard: true } }
    )
  } catch (e) {
    console.error('/start:', e.message)
    safeSend(chatId, "⚠️ Xato yuz berdi. Qayta urinib ko'ring.")
  }
})

// ════════════════════════════════
//  MESSAGE
// ════════════════════════════════
bot.on('message', async msg => {
  const chatId = String(msg.chat.id)
  const text   = (msg.text || '').trim()
  console.log('MSG:', text || '[location]', 'FROM:', chatId)

  if (text.startsWith('/')) return
  if (msg.location) return handleLiveLocation(chatId, msg.location)

  if ((sessions[chatId] || {}).step === 'pin') return handlePin(chatId, text)

  try {
    const user = await findUser(chatId)
    if (!user) {
      sessions[chatId] = { step: 'pin' }
      return safeSend(chatId, "⚠️ Siz ro'yxatdan o'tmagansiz. PIN kodingizni kiriting:")
    }
    if (user.type === 'driver') return handleDriverMsg(chatId, text, user.doc)
    if (user.type === 'worker') return handleWorkerMsg(chatId, text, user.doc)
  } catch (e) {
    console.error('message:', e.message)
    safeSend(chatId, "⚠️ Xato. Qayta urinib ko'ring.")
  }
})

// ════════════════════════════════
//  CALLBACK QUERY
// ════════════════════════════════
bot.on('callback_query', async q => {
  const chatId = String(q.message.chat.id)
  const [action, id] = (q.data || '').split(':')
  console.log('CALLBACK:', q.data)
  try { await bot.answerCallbackQuery(q.id) } catch {}

  if (action === 'driver_done') {
    try {
      const task = await Task.findById(id)
      if (!task) return safeSend(chatId, '⚠️ Topshiriq topilmadi.')
      task.status = 'yetkazildi'
      task.doneAt = new Date()
      await task.save()
      if (task.orderId) await syncOrderStats(task.orderId)
      else { await invalidateCache(['orders', 'delivery', 'pickup', 'dashboard']); broadcast('orders') }
      bot.editMessageReplyMarkup({ inline_keyboard: [] },
        { chat_id: chatId, message_id: q.message.message_id }).catch(() => {})
      safeSend(chatId,
        `✅ *Topshiriq yakunlandi!*\n\n📦 ${task.order || ''}\n👤 ${task.customer || ''}\nVaqt: ${nowT()}`)
    } catch (e) {
      console.error('driver_done:', e.message)
      safeSend(chatId, '⚠️ Topshiriqni yangilashda xato.')
    }
  }

  if (action === 'worker_done') {
    try {
      const { item, nextStage, earned } = await advanceOrderItem(id)
      bot.editMessageReplyMarkup({ inline_keyboard: [] },
        { chat_id: chatId, message_id: q.message.message_id }).catch(() => {})
      safeSend(chatId,
        `✅ *${item.name}* — *${nextStage}* bosqichga o'tdi!\n` +
        (earned > 0 ? `💰 Balansingizga *${fc(earned)}* qo'shildi!` : ''))
    } catch (e) {
      safeSend(chatId, e.status === 409
        ? '⚠️ Bu bosqich allaqachon yangilangan.'
        : "⚠️ Xato. Qayta urinib ko'ring.")
    }
  }

  if (action === 'pickup_accept' || action === 'delivery_accept') {
    try {
      await Task.findByIdAndUpdate(id, { status: 'jarayonda' })
      await invalidateCache(['delivery', 'pickup'])
      broadcast(action.includes('pickup') ? 'pickup' : 'delivery')
      bot.editMessageReplyMarkup({ inline_keyboard: [] },
        { chat_id: chatId, message_id: q.message.message_id }).catch(() => {})
      safeSend(chatId, '✅ *Topshiriq qabul qilindi!* 💪')
    } catch (e) { console.error('accept:', e.message) }
  }

  if (action === 'pickup_reject' || action === 'delivery_reject') {
    bot.editMessageReplyMarkup({ inline_keyboard: [] },
      { chat_id: chatId, message_id: q.message.message_id }).catch(() => {})
    safeSend(chatId, '❌ Topshiriq rad etildi.')
  }
})

// ════════════════════════════════
//  PIN
// ════════════════════════════════
async function handlePin(chatId, text) {
  try {
    const [emp, drv] = await Promise.all([
      Employee.findOne({ pin: text }),
      Driver.findOne({ pin: text }),
    ])
    const found = emp || drv
    if (!found) return safeSend(chatId, "❌ *Noto'g'ri PIN!* Qayta urinib ko'ring.")

    if (found.tgChatId && found.tgChatId !== chatId)
      return safeSend(chatId, "⚠️ Bu PIN boshqa qurilmada. Admin bilan bog'laning.")

    const type = emp ? 'worker' : 'driver'
    await (emp
      ? Employee.findByIdAndUpdate(found._id, { tgChatId: chatId })
      : Driver.findByIdAndUpdate(found._id, { tgChatId: chatId }))

    delete sessions[chatId]
    await safeSend(chatId,
      `✅ *Xush kelibsiz, ${found.name}!*\n` +
      `${type === 'driver' ? '🚗 Shafyor' : '👷 Ishchi'} sifatida kirildi.`)

    const fresh = await (type === 'driver'
      ? Driver.findById(found._id).lean()
      : Employee.findById(found._id).lean())
    return sendMainMenu(chatId, { type, doc: fresh })
  } catch (e) {
    console.error('handlePin:', e.message)
    safeSend(chatId, "⚠️ Xato. Qayta urinib ko'ring.")
  }
}

// ════════════════════════════════
//  MENUS
// ════════════════════════════════
function sendMainMenu(chatId, user) {
  if (user.type === 'driver') return sendDriverMenu(chatId, user.doc)
  if (user.type === 'worker') return sendWorkerMenu(chatId, user.doc)
}

async function sendDriverMenu(chatId, driver) {
  try {
    const tasks = await Task.countDocuments({
      $or: [{ driverId: driver._id }, { driver: driver.name }],
      status: { $in: ['yangi', 'jarayonda'] },
      deletedAt: { $exists: false },
    })
    safeSend(chatId,
      `🚗 *${driver.name}*\n\nFaol topshiriqlar: *${tasks} ta*\nVaqt: ${nowT()}`,
      {
        reply_markup: {
          keyboard: [
            [{ text: '📋 Topshiriqlarim' }, { text: '📍 Lokatsiyam' }],
            [{ text: '✅ Topshirildi' },    { text: '📊 Statistika' }],
            [{ text: '📡 Live GPS yoqish', request_location: true }],
          ],
          resize_keyboard: true,
        }
      }
    )
  } catch (e) { console.error('driverMenu:', e.message) }
}

async function sendWorkerMenu(chatId, worker) {
  try {
    const [emp, att] = await Promise.all([
      Employee.findById(worker._id).select('name section balance').lean(),
      Attendance.findOne({ employeeId: String(worker._id), date: today() }).lean(),
    ])
    const isIn = att?.checkIn && !att?.checkOut
    safeSend(chatId,
      `👷 *${emp.name}*\n\n` +
      `Bo'lim: ${emp.section || '—'}\n` +
      `Balans: *${fc(emp.balance)}*\n` +
      `Bugun: ${att?.checkIn ? `✅ Kirdi ${att.checkIn}` : '❌ Kirmadi'}\n` +
      `Vaqt: ${nowT()}`,
      {
        reply_markup: {
          keyboard: [
            [{ text: isIn ? '🚪 Ishdan chiqish' : '✅ Ishga kirdim' }, { text: '📋 Topshiriqlarim' }],
            [{ text: '💰 Balansim' }, { text: '📊 Oylik hisobot' }],
          ],
          resize_keyboard: true,
        }
      }
    )
  } catch (e) { console.error('workerMenu:', e.message) }
}

// ════════════════════════════════
//  DRIVER HANDLER
// ════════════════════════════════
async function handleDriverMsg(chatId, text, driver) {
  try {
    switch (text) {
      case '📋 Topshiriqlarim': {
        const tasks = await Task.find({
          $or: [{ driverId: driver._id }, { driver: driver.name }],
          status: { $in: ['yangi', 'jarayonda'] },
          deletedAt: { $exists: false },
        }).sort({ createdAt: -1 }).limit(10).lean()

        if (!tasks.length) return safeSend(chatId, "📭 Hozircha topshiriq yo'q.")

        for (const t of tasks) {
          const mapUrl = t.lat && t.lon
            ? `https://maps.google.com/?q=${t.lat},${t.lon}`
            : `https://yandex.com/maps/?text=${encodeURIComponent(t.address || '')}`
          await safeSend(chatId,
            `${t.type === 'delivery' ? '📦' : '📮'} *${t.order || '—'}*\n` +
            `👤 ${t.customer || '—'}\n📍 ${t.address || '—'}\n📞 ${t.phone || '—'}`,
            {
              reply_markup: { inline_keyboard: [[
                { text: '🗺️ Xarita',    url: mapUrl },
                { text: '✅ Yetkazildi', callback_data: `driver_done:${t._id}` },
              ]] }
            }
          )
        }
        break
      }
      case '📍 Lokatsiyam':
        safeSend(chatId, '📡 Lokatsiyangizni yuboring:', {
          reply_markup: { keyboard: [
            [{ text: '📍 Yuborish', request_location: true }],
            [{ text: '🔙 Menyu' }],
          ], resize_keyboard: true }
        })
        break
      case '✅ Topshirildi': {
        const tasks = await Task.find({
          $or: [{ driverId: driver._id }, { driver: driver.name }],
          status: { $in: ['yangi', 'jarayonda'] },
          deletedAt: { $exists: false },
        }).limit(5).lean()
        if (!tasks.length) return safeSend(chatId, "Faol topshiriq yo'q.")
        safeSend(chatId, 'Qaysi topshiriq yakunlandi?', {
          reply_markup: { inline_keyboard: tasks.map(t => ([{
            text: `${t.order || '?'} — ${t.customer || ''}`,
            callback_data: `driver_done:${t._id}`,
          }])) }
        })
        break
      }
      case '📊 Statistika': {
        const monthStart = new Date(new Date().setDate(1))
        const [done, month] = await Promise.all([
          Task.countDocuments({ $or: [{ driverId: driver._id }, { driver: driver.name }], status: 'yetkazildi', deletedAt: { $exists: false } }),
          Task.countDocuments({ $or: [{ driverId: driver._id }, { driver: driver.name }], status: 'yetkazildi', createdAt: { $gte: monthStart }, deletedAt: { $exists: false } }),
        ])
        safeSend(chatId, `📊 *${driver.name}*\n\n✅ Jami: ${done} ta\n📅 Bu oy: ${month} ta`)
        break
      }
      default: return sendDriverMenu(chatId, driver)
    }
  } catch (e) {
    console.error('driverMsg:', e.message)
    safeSend(chatId, "⚠️ Xato. Qayta urinib ko'ring.")
  }
}

// ════════════════════════════════
//  WORKER HANDLER
// ════════════════════════════════
async function handleWorkerMsg(chatId, text, worker) {
  try {
    switch (text) {
      case '✅ Ishga kirdim': {
        const existing = await Attendance.findOne({ employeeId: String(worker._id), date: today() })
        if (existing?.checkIn) return safeSend(chatId, `✅ Allaqachon kirdingiz: *${existing.checkIn}*`)
        await Attendance.findOneAndUpdate(
          { employeeId: String(worker._id), date: today() },
          { $set: { employeeId: String(worker._id), date: today(), checkIn: nowT(), status: 'keldi' } },
          { upsert: true }
        )
        await invalidateCache(['attendance', 'dashboard'])
        broadcast('attendance')
        await safeSend(chatId, `✅ *Ishga kirdingiz!*\nVaqt: *${nowT()}* 💪`)
        const emp = await Employee.findById(worker._id).lean()
        return sendWorkerMenu(chatId, emp)
      }
      case '🚪 Ishdan chiqish': {
        const existing = await Attendance.findOne({ employeeId: String(worker._id), date: today() })
        if (!existing?.checkIn) return safeSend(chatId, '⚠️ Bugun kirish qayd etilmagan.')
        if (existing.checkOut) return safeSend(chatId, `ℹ️ Allaqachon chiqdingiz: *${existing.checkOut}*`)
        await Attendance.findByIdAndUpdate(existing._id, { $set: { checkOut: nowT() } })
        await invalidateCache(['attendance', 'dashboard'])
        broadcast('attendance')
        await safeSend(chatId, `🚪 *Ishdan chiqdingiz!*\nKirish: *${existing.checkIn}* | Chiqish: *${nowT()}* 👋`)
        const emp = await Employee.findById(worker._id).lean()
        return sendWorkerMenu(chatId, emp)
      }
      case '📋 Topshiriqlarim': {
        const wid   = String(worker._id)
        const items = await OrderItem.find({
          $or: [{ 'assignments.workerId': wid }, { 'assignments.workerId': worker._id }],
          stage: { $nin: ['tugallandi'] },
          deletedAt: { $exists: false },
        }).limit(10).lean()
        const myItems = items.filter(i => i.assignments?.some(a => String(a.workerId) === wid && !a.doneAt))
        if (!myItems.length) return safeSend(chatId, "📭 Hozircha faol topshiriq yo'q.")
        for (const item of myItems) {
          await safeSend(chatId,
            `📋 *${item.name}*\n` +
            `📍 Bosqich: ${item.stage}\n` +
            `${item.unit === 'sqm' ? `📐 ${item.sqm} kv.m` : `🔢 ${item.qty} dona`}\n` +
            `💰 ${fc(item.pricePerUnit)}/${item.unit === 'sqm' ? 'kv.m' : 'dona'}`,
            { reply_markup: { inline_keyboard: [[{ text: '✅ Bosqich tugallandi', callback_data: `worker_done:${item._id}` }]] } }
          )
        }
        break
      }
      case '💰 Balansim': {
        const emp = await Employee.findById(worker._id).select('name section balance advancePaid').lean()
        safeSend(chatId,
          `💰 *${emp.name}*\n\n` +
          `Joriy balans: *${fc(emp.balance)}*\n` +
          `Berilgan avans: *${fc(emp.advancePaid)}*\n` +
          `Bo'lim: ${emp.section || '—'}`)
        break
      }
      case '📊 Oylik hisobot': {
        const mStart = new Date(new Date().setDate(1))
        const [emp, days, doneItems] = await Promise.all([
          Employee.findById(worker._id).select('name balance').lean(),
          Attendance.countDocuments({
            employeeId: String(worker._id),
            date: { $gte: mStart.toISOString().slice(0, 10) },
            checkIn: { $exists: true },
          }),
          OrderItem.find({
            $or: [{ 'assignments.workerId': String(worker._id) }, { 'assignments.workerId': worker._id }],
            'assignments.doneAt': { $gte: mStart },
          }).lean(),
        ])
        const earned = doneItems.reduce((s, i) => {
          const a = i.assignments?.find(a =>
            String(a.workerId) === String(worker._id) && a.doneAt && new Date(a.doneAt) >= mStart)
          return s + (a?.earned || 0)
        }, 0)
        safeSend(chatId,
          `📊 *Bu oy*\n\n` +
          `✅ Ish kunlari: *${days} kun*\n` +
          `💰 Hisoblangan: *${fc(earned)}*\n` +
          `💳 Joriy balans: *${fc(emp.balance)}*`)
        break
      }
      default: return sendWorkerMenu(chatId, worker)
    }
  } catch (e) {
    console.error('workerMsg:', e.message)
    safeSend(chatId, "⚠️ Xato. Qayta urinib ko'ring.")
  }
}

// ════════════════════════════════
//  LIVE LOCATION
// ════════════════════════════════
async function handleLiveLocation(chatId, location) {
  try {
    const driver = await Driver.findOne({ tgChatId: chatId }).lean()
    if (!driver) return
    const data = {
      telegramId: chatId,
      driverId:   String(driver._id),
      name:       driver.name,
      latitude:   location.latitude,
      longitude:  location.longitude,
      speed:      location.speed || 0,
      ts:         Date.now(),
      online:     true,
    }
    const cache = require('../redis/cache')
    await cache.set(`driver_loc:${chatId}`, JSON.stringify(data), 300)
    if (global.__io) global.__io.emit('driver:live-location', data)
  } catch (e) { console.error('liveLocation:', e.message) }
}

// ════════════════════════════════
//  EXPORTS
// ════════════════════════════════
async function notifyDriver(driverName, message, inlineButtons) {
  try {
    const driver = await Driver.findOne({ name: driverName, tgChatId: { $exists: true, $ne: '' } })
    if (!driver?.tgChatId) return false
    await safeSend(driver.tgChatId, message,
      inlineButtons ? { reply_markup: { inline_keyboard: inlineButtons } } : {})
    return true
  } catch (e) { console.error('notifyDriver:', e.message); return false }
}

async function notifyWorker(workerId, message, inlineButtons) {
  try {
    const w = await Employee.findById(workerId)
    if (!w?.tgChatId) return false
    await safeSend(w.tgChatId, message,
      inlineButtons ? { reply_markup: { inline_keyboard: inlineButtons } } : {})
    return true
  } catch (e) { console.error('notifyWorker:', e.message); return false }
}

async function getAllLiveLocations() {
  try {
    const cache = require('../redis/cache')
    const keys  = await cache.keys('driver_loc:*')
    if (!keys?.length) return []
    const locs  = await Promise.all(keys.map(k => cache.get(k)))
    return locs.filter(Boolean).map(l => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}

// ─── Error handlers ───
bot.on('polling_error', err => console.error('❌ POLLING ERROR:', err.message))
bot.on('error',         err => console.error('❌ BOT ERROR:', err.message))
process.on('unhandledRejection', err => console.error('❌ UNHANDLED:', err))
process.on('uncaughtException',  err => { console.error('❌ CRASH:', err.message); process.exit(1) })

module.exports = { bot, notifyDriver, notifyWorker, getAllLiveLocations }
