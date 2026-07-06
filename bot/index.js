'use strict'
// ═══════════════════════════════════════════════════════════
//  TARTIB CRM BOT
//  Bitta fayl — bitta TelegramBot instance — bitta polling
//
//  SHAFYOR FUNKSIYALARI:
//    /start → PIN → Shafyor menyusi
//    🟢 Ishni boshlash / 🔴 Ishni tugatish
//    📋 Topshiriqlarim → topshiriq kartasi + xarita
//    📡 Live GPS → WebApp ochiladi
//    📍 Lokatsiyam → bir martalik joylashuv
//    ✅ Topshirildi → yakunlash
//    📊 Statistika
//    [callback] driver_done → topshiriq tugallandi
//    [callback] pickup/delivery accept/reject
//    [edited_message] Live Location yangilanadi
//
//  ISHCHI FUNKSIYALARI:
//    /start → PIN → Ishchi menyusi
//    ✅ Ishga kirdim / 🚪 Ishdan chiqish → Attendance
//    📋 Topshiriqlarim → OrderItem kartasi + tugma
//    💰 Balansim
//    📊 Oylik hisobot
//    [callback] worker_done → bosqich tugallandi + balans
// ═══════════════════════════════════════════════════════════

require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

const TelegramBot = require('node-telegram-bot-api').default
                 || require('node-telegram-bot-api')
const mongoose    = require('mongoose')
const cache       = require('../redis/cache')

const { Driver, Employee, OrderItem, Task, Attendance } = require('../models')
const { advanceOrderItem, syncOrderStats } = require('../services/orderSync')
const { broadcast }       = require('../routes/_broadcast')
const { invalidateCache } = require('../redis/cacheMiddleware')

// ── Konstantalar ──
const TOKEN      = process.env.BOT_TOKEN
const WEBAPP_URL = (process.env.WEBAPP_URL || 'https://demo.tartibcrm.uz/driver-app')
                    .replace('http://', 'https://')   // HTTPS kafolati

if (!TOKEN) { console.error('❌ BOT_TOKEN topilmadi!'); process.exit(1) }

// ── Bot instance — BITTA ──
const bot = new TelegramBot(TOKEN, { polling: false })
global.__bot = bot

// ── MongoDB → keyin polling ──
async function startBot() {
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 20000,
        bufferCommands: false,
      })
      console.log('✅ Bot: MongoDB ulandi')
    }
    bot.startPolling({ interval: 300, params: { timeout: 10 } })
    console.log('🚀 Bot ishga tushdi...')
  } catch (e) {
    console.error('❌ Bot MongoDB:', e.message)
    setTimeout(startBot, 5000)
  }
}
startBot()

// ── Helpers ──
const fc    = n => (n || 0).toLocaleString('ru-RU') + " so'm"
const nowT  = () => new Date().toLocaleTimeString('uz-UZ', { hour:'2-digit', minute:'2-digit' })
const today = () => new Date().toISOString().slice(0, 10)

// Session — PIN bosqichi uchun
const sessions = {}

// safeSend — xato bo'lsa server crash bo'lmaydi
async function safeSend(chatId, text, opts = {}) {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode:'Markdown', ...opts })
  } catch (e) {
    console.error(`SEND ERR [${chatId}]:`, e.message)
  }
}

// findUser — parallel query (tezroq)
async function findUser(chatId) {
  const cid = String(chatId)
  const [drv, emp] = await Promise.all([
    Driver.findOne({ tgChatId: cid }).lean(),
    Employee.findOne({ tgChatId: cid }).lean(),
  ])
  if (drv) return { type:'driver', doc:drv }
  if (emp) return { type:'worker', doc:emp }
  return null
}

// editMarkup — inline tugmalarni o'chirish
function clearMarkup(chatId, messageId) {
  bot.editMessageReplyMarkup({ inline_keyboard:[] },
    { chat_id:chatId, message_id:messageId }).catch(() => {})
}

// ═══════════════════════════════════════════
//  /start
// ═══════════════════════════════════════════
bot.onText(/\/start/, async msg => {
  const chatId = String(msg.chat.id)
  try {
    const user = await findUser(chatId)
    if (user) return sendMenu(chatId, user)
    sessions[chatId] = 'pin'
    safeSend(chatId,
      `👋 *Xush kelibsiz — Tartib CRM*\n\n` +
      `Tizimga kirish uchun *4 xonali PIN kodingizni* yuboring.\n` +
      `📌 PIN kodni admindan oling.`,
      { reply_markup:{ remove_keyboard:true } }
    )
  } catch(e) {
    console.error('/start:', e.message)
    safeSend(chatId, "⚠️ Xato. Qayta /start bosing.")
  }
})

// ═══════════════════════════════════════════
//  MESSAGE
// ═══════════════════════════════════════════
bot.on('message', async msg => {
  const chatId = String(msg.chat.id)
  const text   = (msg.text || '').trim()

  if (text.startsWith('/')) return
  if (msg.location) return onLiveLocation(chatId, msg.location)

  if (sessions[chatId] === 'pin') return onPin(chatId, text)

  try {
    const user = await findUser(chatId)
    if (!user) {
      sessions[chatId] = 'pin'
      return safeSend(chatId, "⚠️ Siz ro'yxatdan o'tmagansiz. PIN kodingizni kiriting:")
    }
    if (user.type === 'driver') return onDriverText(chatId, text, user.doc)
    if (user.type === 'worker') return onWorkerText(chatId, text, user.doc)
  } catch(e) {
    console.error('message:', e.message)
    safeSend(chatId, "⚠️ Xato. Qayta urinib ko'ring.")
  }
})

// ═══════════════════════════════════════════
//  LIVE LOCATION (edited_message)
// ═══════════════════════════════════════════
bot.on('edited_message', async msg => {
  if (!msg.location) return
  await onLiveLocation(String(msg.chat.id), msg.location)
})

async function onLiveLocation(chatId, location) {
  try {
    const drv = await Driver.findOne({ tgChatId:chatId }).lean()
    if (!drv) return
    const data = {
      telegramId: chatId,
      driverId:   String(drv._id),
      name:       drv.name,
      latitude:   location.latitude,
      longitude:  location.longitude,
      speed:      location.speed || 0,
      ts:         Date.now(),
      online:     true,
    }
    await cache.set(`driver_loc:${chatId}`, JSON.stringify(data), 300)
    if (global.__io) global.__io.emit('driver:live-location', data)
  } catch(e) { console.error('liveLocation:', e.message) }
}

// ═══════════════════════════════════════════
//  CALLBACK QUERY
// ═══════════════════════════════════════════
bot.on('callback_query', async q => {
  const chatId = String(q.message.chat.id)
  const msgId  = q.message.message_id
  const [action, id] = (q.data || '').split(':')

  try { await bot.answerCallbackQuery(q.id) } catch {}

  try {
    switch(action) {

      case 'driver_done': {
        const task = await Task.findByIdAndUpdate(id,
          { status:'yetkazildi', doneAt:new Date() }, { new:true })
        if (!task) return safeSend(chatId, '⚠️ Topshiriq topilmadi.')
        if (task.orderId) await syncOrderStats(task.orderId)
        else { await invalidateCache(['orders','delivery','pickup','dashboard']); broadcast('orders') }
        clearMarkup(chatId, msgId)
        safeSend(chatId,
          `✅ *Topshiriq yakunlandi!*\n\n` +
          `📦 ${task.order || ''}\n👤 ${task.customer || ''}\nVaqt: ${nowT()}`)
        break
      }

      case 'worker_done': {
        const { item, nextStage, earned } = await advanceOrderItem(id)
        clearMarkup(chatId, msgId)
        safeSend(chatId,
          `✅ *${item.name}* — *${nextStage}* bosqichga o'tdi!\n` +
          (earned > 0 ? `💰 Balansingizga *${fc(earned)}* qo'shildi!` : ''))
        break
      }

      case 'pickup_accept':
      case 'delivery_accept': {
        await Task.findByIdAndUpdate(id, { status:'jarayonda' })
        await invalidateCache(['delivery','pickup'])
        broadcast(action.includes('pickup') ? 'pickup' : 'delivery')
        clearMarkup(chatId, msgId)
        safeSend(chatId, '✅ *Topshiriq qabul qilindi!* 💪')
        break
      }

      case 'pickup_reject':
      case 'delivery_reject': {
        clearMarkup(chatId, msgId)
        safeSend(chatId, '❌ Topshiriq rad etildi.')
        break
      }
    }
  } catch(e) {
    console.error('callback', action, e.message)
    safeSend(chatId, e.status === 409
      ? '⚠️ Bu bosqich allaqachon yangilangan.'
      : "⚠️ Xato. Qayta urinib ko'ring.")
  }
})

// ═══════════════════════════════════════════
//  PIN — ro'yxatdan o'tish
// ═══════════════════════════════════════════
async function onPin(chatId, text) {
  try {
    const [emp, drv] = await Promise.all([
      Employee.findOne({ pin:text }),
      Driver.findOne({ pin:text }),
    ])
    const found = emp || drv
    if (!found) return safeSend(chatId, "❌ *Noto'g'ri PIN!* Qayta urinib ko'ring.")

    if (found.tgChatId && found.tgChatId !== chatId)
      return safeSend(chatId, "⚠️ Bu PIN boshqa qurilmada. Admindan yangi PIN oling.")

    const type = emp ? 'worker' : 'driver'
    await (emp
      ? Employee.findByIdAndUpdate(found._id, { tgChatId:chatId })
      : Driver.findByIdAndUpdate(found._id, { tgChatId:chatId }))

    delete sessions[chatId]
    await safeSend(chatId,
      `✅ *Xush kelibsiz, ${found.name}!*\n` +
      `${type === 'driver' ? '🚗 Shafyor' : '👷 Ishchi'} sifatida kirildi.`)

    const fresh = type === 'driver'
      ? await Driver.findById(found._id).lean()
      : await Employee.findById(found._id).lean()
    sendMenu(chatId, { type, doc:fresh })
  } catch(e) {
    console.error('onPin:', e.message)
    safeSend(chatId, "⚠️ Xato. Qayta urinib ko'ring.")
  }
}

// ═══════════════════════════════════════════
//  MENYULAR
// ═══════════════════════════════════════════
function sendMenu(chatId, user) {
  if (user.type === 'driver') return driverMenu(chatId, user.doc)
  if (user.type === 'worker') return workerMenu(chatId, user.doc)
}

async function driverMenu(chatId, drv) {
  try {
    const tasks = await Task.countDocuments({
      $or: [{ driverId:drv._id }, { driver:drv.name }],
      status: { $in:['yangi','jarayonda'] },
      deletedAt: { $exists:false },
    })
    await safeSend(chatId,
      `🚗 *${drv.name}*\n\n` +
      `Holat: ${drv.isWorking ? '🟢 Ish vaqti' : '⚫ Dam olmoqda'}\n` +
      `Faol topshiriqlar: *${tasks} ta*\n` +
      `Vaqt: ${nowT()}`,
      { reply_markup:{ keyboard:[
        [{ text: drv.isWorking ? '🔴 Ishni tugatish' : '🟢 Ishni boshlash' }],
        [{ text:'📋 Topshiriqlarim' }, { text:'📍 Lokatsiyam' }],
        [{ text:'✅ Topshirildi' },    { text:'📊 Statistika' }],
        [{ text:'📡 Live GPS yoqish', web_app:{ url:WEBAPP_URL } }],
      ], resize_keyboard:true } }
    )
  } catch(e) { console.error('driverMenu:', e.message) }
}

async function workerMenu(chatId, wrk) {
  try {
    const [emp, att] = await Promise.all([
      Employee.findById(wrk._id).select('name section balance').lean(),
      Attendance.findOne({ employeeId:String(wrk._id), date:today() }).lean(),
    ])
    const isIn = att?.checkIn && !att?.checkOut
    await safeSend(chatId,
      `👷 *${emp.name}*\n\n` +
      `Bo'lim: ${emp.section || '—'}\n` +
      `Balans: *${fc(emp.balance)}*\n` +
      `Bugun: ${att?.checkIn ? `✅ Kirdi ${att.checkIn}` : '❌ Kirmadi'}\n` +
      `Vaqt: ${nowT()}`,
      { reply_markup:{ keyboard:[
        [{ text: isIn ? '🚪 Ishdan chiqish' : '✅ Ishga kirdim' }, { text:'📋 Topshiriqlarim' }],
        [{ text:'💰 Balansim' }, { text:'📊 Oylik hisobot' }],
      ], resize_keyboard:true } }
    )
  } catch(e) { console.error('workerMenu:', e.message) }
}

// ═══════════════════════════════════════════
//  SHAFYOR XABARLARI
// ═══════════════════════════════════════════
async function onDriverText(chatId, text, drv) {
  switch(text) {

    case '🟢 Ishni boshlash': {
      if (drv.isWorking) return safeSend(chatId, '✅ Siz allaqachon ish vaqtidasiz!')
      await Driver.findByIdAndUpdate(drv._id, { $set:{
        isWorking:true, workStartedAt:new Date(), status:'faol',
        webappOpenedAt:null, webappClosedAt:null, gpsReminderAt:null,
      }})
      await invalidateCache(['drivers','dashboard'])
      broadcast('drivers')
      await safeSend(chatId,
        `🟢 *Ish boshlandi!* — ${nowT()}\n\nGPS kuzatuvni yoqing 👇`,
        { reply_markup:{ inline_keyboard:[[
          { text:'📡 GPS Yoqish', web_app:{ url:WEBAPP_URL } },
        ]]} }
      )
      const fresh = await Driver.findById(drv._id).lean()
      return driverMenu(chatId, fresh)
    }

    case '🔴 Ishni tugatish': {
      if (!drv.isWorking) return safeSend(chatId, '⚫ Siz hozir ish vaqtida emassiz.')
      await Driver.findByIdAndUpdate(drv._id, { $set:{
        isWorking:false, workStartedAt:null, status:'dam',
      }})
      await invalidateCache(['drivers','dashboard'])
      broadcast('drivers')
      await cache.del(`driver_loc:${chatId}`).catch(() => {})
      await safeSend(chatId, `🔴 *Ish tugadi!* — ${nowT()}\n\nYaxshi dam oling! 👋`)
      const fresh = await Driver.findById(drv._id).lean()
      return driverMenu(chatId, fresh)
    }

    case '📋 Topshiriqlarim': {
      const tasks = await Task.find({
        $or: [{ driverId:drv._id }, { driver:drv.name }],
        status: { $in:['yangi','jarayonda'] },
        deletedAt: { $exists:false },
      }).sort({ createdAt:-1 }).limit(10).lean()

      if (!tasks.length) return safeSend(chatId, "📭 Hozircha topshiriq yo'q.")

      for (const t of tasks) {
        const mapUrl = t.lat && t.lon
          ? `https://maps.google.com/?q=${t.lat},${t.lon}`
          : `https://yandex.com/maps/?text=${encodeURIComponent(t.address || '')}`
        await safeSend(chatId,
          `${t.type === 'delivery' ? '📦 Yetkazish' : '📮 Olib kelish'}\n` +
          `*${t.order || '—'}*\n` +
          `👤 ${t.customer || '—'}\n` +
          `📍 ${t.address || '—'}\n` +
          `📞 ${t.phone || '—'}`,
          { reply_markup:{ inline_keyboard:[[
            { text:'🗺️ Xarita', url:mapUrl },
            { text:'✅ Yetkazildi', callback_data:`driver_done:${t._id}` },
          ]]} }
        )
      }
      break
    }

    case '📍 Lokatsiyam': {
      await safeSend(chatId,
        '📍 Joylashuvingizni yuboring:',
        { reply_markup:{ keyboard:[
          [{ text:'📍 Joylashuvni yuborish', request_location:true }],
          [{ text:'🔙 Orqaga' }],
        ], resize_keyboard:true, one_time_keyboard:true } }
      )
      break
    }

    case '✅ Topshirildi': {
      const tasks = await Task.find({
        $or: [{ driverId:drv._id }, { driver:drv.name }],
        status: { $in:['yangi','jarayonda'] },
        deletedAt: { $exists:false },
      }).limit(8).lean()
      if (!tasks.length) return safeSend(chatId, "📭 Faol topshiriq yo'q.")
      safeSend(chatId, 'Qaysi topshiriq yakunlandi?',
        { reply_markup:{ inline_keyboard: tasks.map(t => ([{
          text: `${t.type==='delivery'?'📦':'📮'} ${t.order||'?'} — ${t.customer||''}`,
          callback_data: `driver_done:${t._id}`,
        }])) } }
      )
      break
    }

    case '📊 Statistika': {
      const mStart = new Date(new Date().setDate(1))
      const q = { $or:[{driverId:drv._id},{driver:drv.name}], status:'yetkazildi', deletedAt:{$exists:false} }
      const [total, month] = await Promise.all([
        Task.countDocuments(q),
        Task.countDocuments({ ...q, createdAt:{ $gte:mStart } }),
      ])
      safeSend(chatId,
        `📊 *${drv.name}*\n\n` +
        `✅ Jami: *${total} ta*\n` +
        `📅 Bu oy: *${month} ta*`)
      break
    }

    case '🔙 Orqaga':
    default:
      driverMenu(chatId, drv)
  }
}

// ═══════════════════════════════════════════
//  ISHCHI XABARLARI
// ═══════════════════════════════════════════
async function onWorkerText(chatId, text, wrk) {
  switch(text) {

    case '✅ Ishga kirdim': {
      const att = await Attendance.findOne({ employeeId:String(wrk._id), date:today() })
      if (att?.checkIn) return safeSend(chatId, `✅ Allaqachon kirdingiz: *${att.checkIn}*`)
      await Attendance.findOneAndUpdate(
        { employeeId:String(wrk._id), date:today() },
        { $set:{ employeeId:String(wrk._id), date:today(), checkIn:nowT(), status:'keldi' } },
        { upsert:true }
      )
      await invalidateCache(['attendance','dashboard'])
      broadcast('attendance')
      await safeSend(chatId, `✅ *Ishga kirdingiz!*\nVaqt: *${nowT()}* 💪`)
      const emp = await Employee.findById(wrk._id).lean()
      return workerMenu(chatId, emp)
    }

    case '🚪 Ishdan chiqish': {
      const att = await Attendance.findOne({ employeeId:String(wrk._id), date:today() })
      if (!att?.checkIn)  return safeSend(chatId, '⚠️ Bugun kirish qayd etilmagan.')
      if (att?.checkOut)  return safeSend(chatId, `ℹ️ Allaqachon chiqdingiz: *${att.checkOut}*`)
      await Attendance.findByIdAndUpdate(att._id, { $set:{ checkOut:nowT() } })
      await invalidateCache(['attendance','dashboard'])
      broadcast('attendance')
      await safeSend(chatId, `🚪 *Ishdan chiqdingiz!*\nKirish: *${att.checkIn}* | Chiqish: *${nowT()}* 👋`)
      const emp = await Employee.findById(wrk._id).lean()
      return workerMenu(chatId, emp)
    }

    case '📋 Topshiriqlarim': {
      const wid   = String(wrk._id)
      const items = await OrderItem.find({
        $or: [{ 'assignments.workerId':wid }, { 'assignments.workerId':wrk._id }],
        stage: { $nin:['tugallandi'] },
        deletedAt: { $exists:false },
      }).limit(10).lean()

      const mine = items.filter(i =>
        i.assignments?.some(a => String(a.workerId) === wid && !a.doneAt)
      )
      if (!mine.length) return safeSend(chatId, "📭 Hozircha faol topshiriq yo'q.")

      for (const item of mine) {
        await safeSend(chatId,
          `📋 *${item.name}*\n` +
          `📍 Bosqich: *${item.stage}*\n` +
          `${item.unit==='sqm' ? `📐 ${item.sqm} kv.m` : `🔢 ${item.qty} dona`}\n` +
          `💰 ${fc(item.pricePerUnit)}/${item.unit==='sqm'?'kv.m':'dona'}`,
          { reply_markup:{ inline_keyboard:[[
            { text:'✅ Bosqich tugallandi', callback_data:`worker_done:${item._id}` }
          ]]} }
        )
      }
      break
    }

    case '💰 Balansim': {
      const emp = await Employee.findById(wrk._id)
        .select('name section balance advancePaid').lean()
      safeSend(chatId,
        `💰 *${emp.name}*\n\n` +
        `Joriy balans: *${fc(emp.balance)}*\n` +
        `Berilgan avans: *${fc(emp.advancePaid)}*\n` +
        `Bo'lim: ${emp.section||'—'}`)
      break
    }

    case '📊 Oylik hisobot': {
      const mStart = new Date(new Date().setDate(1))
      const [emp, days, items] = await Promise.all([
        Employee.findById(wrk._id).select('name balance').lean(),
        Attendance.countDocuments({
          employeeId: String(wrk._id),
          date: { $gte:mStart.toISOString().slice(0,10) },
          checkIn: { $exists:true },
        }),
        OrderItem.find({
          $or: [{ 'assignments.workerId':String(wrk._id) }, { 'assignments.workerId':wrk._id }],
          'assignments.doneAt': { $gte:mStart },
        }).lean(),
      ])
      const earned = items.reduce((s,i) => {
        const a = i.assignments?.find(a =>
          String(a.workerId)===String(wrk._id) && a.doneAt && new Date(a.doneAt)>=mStart)
        return s + (a?.earned || 0)
      }, 0)
      safeSend(chatId,
        `📊 *Bu oy*\n\n` +
        `✅ Ish kunlari: *${days} kun*\n` +
        `💰 Hisoblangan: *${fc(earned)}*\n` +
        `💳 Joriy balans: *${fc(emp.balance)}*`)
      break
    }

    default:
      workerMenu(chatId, wrk)
  }
}

// ═══════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════
async function notifyDriver(driverName, message, inlineButtons) {
  try {
    const drv = await Driver.findOne({ name:driverName, tgChatId:{ $exists:true, $ne:'' } })
    if (!drv?.tgChatId) return false
    await safeSend(drv.tgChatId, message,
      inlineButtons ? { reply_markup:{ inline_keyboard:inlineButtons } } : {})
    return true
  } catch(e) { console.error('notifyDriver:', e.message); return false }
}

async function notifyWorker(workerId, message, inlineButtons) {
  try {
    const w = await Employee.findById(workerId)
    if (!w?.tgChatId) return false
    await safeSend(w.tgChatId, message,
      inlineButtons ? { reply_markup:{ inline_keyboard:inlineButtons } } : {})
    return true
  } catch(e) { console.error('notifyWorker:', e.message); return false }
}

async function getAllLiveLocations() {
  try {
    const keys = await cache.keys('driver_loc:*')
    if (!keys?.length) return []
    const vals = await Promise.all(keys.map(k => cache.get(k)))
    return vals.filter(Boolean).map(v => { try { return JSON.parse(v) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

// ── Error handlers ──
bot.on('polling_error', err => console.error('❌ POLLING ERROR:', err.message))
bot.on('error',         err => console.error('❌ BOT ERROR:', err.message))
process.on('unhandledRejection', err => console.error('❌ UNHANDLED:', err?.message || err))
process.on('uncaughtException',  err => { console.error('❌ CRASH:', err.message); process.exit(1) })

module.exports = { bot, notifyDriver, notifyWorker, getAllLiveLocations }
