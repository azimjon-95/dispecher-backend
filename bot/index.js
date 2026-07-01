// =============================================
//  TARTIB CRM BOT v4  (senior refactor)
//  Tuzatilgan:
//  - #2 Davomat: Attendance modeli orqali (array emas)
//  - #4 driver_done: syncOrderStats + broadcast
//  - #6 workerId: ObjectId va String ikkalasi
//  - #8 try/catch: barcha handlerlarda
//  - #1 findUser: Promise.all parallel
//  - #9 PIN: parallel qidiruv
// =============================================
require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

// VPN Proxy (ixtiyoriy, lokal test uchun)
if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY) {
  try {
    require('global-agent/bootstrap')
    const proxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY
    process.env.GLOBAL_AGENT_HTTP_PROXY  = proxy
    process.env.GLOBAL_AGENT_HTTPS_PROXY = proxy
    console.log('🔒 VPN Proxy:', proxy)
  } catch { console.warn('⚠️  global-agent yo\'q') }
}

const TelegramBot = require('node-telegram-bot-api')
const mongoose    = require('mongoose')

mongoose.connect(process.env.MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 20000,
  bufferCommands: false,
})
  .then(() => console.log('✅ Bot: MongoDB ulandi'))
  .catch(e => console.error('❌ Bot DB:', e.message))

const { Driver, Employee, Order, OrderItem, Task, Attendance } = require('../models')
const { advanceOrderItem, syncOrderStats } = require('../services/orderSync')
const { broadcast } = require('../routes/_broadcast')
const { invalidateCache } = require('../redis/cacheMiddleware')

const TOKEN = process.env.BOT_TOKEN
if (!TOKEN) { console.error('❌ BOT_TOKEN yo\'q!'); process.exit(1) }

const bot = new TelegramBot(TOKEN, { polling: true })
console.log('🤖 Tartib CRM Bot v4 ishga tushdi...')

// ── Helpers ──
const fc    = n => (n||0).toLocaleString('ru-RU') + " so'm"
const nowT  = () => new Date().toLocaleTimeString('uz-UZ', { hour:'2-digit', minute:'2-digit' })
const today = () => new Date().toISOString().slice(0, 10)

// ── PIN sessions (in-memory, restart da tozalanadi — kichik muammo, qabul qilingan) ──
const sessions = {}

// ── Safe send — xato chiqsa log ga yoz, foydalanuvchiga xabar ber ──
async function safeSend(chatId, text, opts = {}) {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...opts })
  } catch (e) {
    console.error(`safeSend [${chatId}]:`, e.message)
  }
}

// ────────────────────────────────────────
//  FIX #1: findUser — parallel DB query
// ────────────────────────────────────────
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  /start
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.onText(/\/start/, async msg => {
  const chatId = String(msg.chat.id)
  try {
    const user = await findUser(chatId)
    if (user) return sendMainMenu(chatId, user)
    sessions[chatId] = { step: 'pin' }
    safeSend(chatId,
      `👋 *Xush kelibsiz — Tartib CRM*\n\n` +
      `Tizimga kirish uchun *4 xonali PIN kodingizni* yuboring.\n\n` +
      `📌 PIN kodni admindan oling.`,
      { reply_markup: { remove_keyboard: true } }
    )
  } catch (e) {
    console.error('/start xato:', e.message)
    safeSend(chatId, '⚠️ Tizimga ulanishda xato yuz berdi. Qayta urinib ko\'ring.')
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  MESSAGE HANDLER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.on('message', async msg => {
  const chatId = String(msg.chat.id)
  const text   = (msg.text || '').trim()
  const sess   = sessions[chatId] || {}

  if (text.startsWith('/')) return

  if (msg.location) return handleLiveLocation(chatId, msg.location)

  if (sess.step === 'pin') return handlePin(chatId, text)

  try {
    const user = await findUser(chatId)
    if (!user) {
      sessions[chatId] = { step: 'pin' }
      return safeSend(chatId, '⚠️ Siz ro\'yxatdan o\'tmagansiz. PIN kodingizni kiriting:')
    }
    if (user.type === 'driver') return handleDriverMsg(chatId, text, user.doc)
    if (user.type === 'worker') return handleWorkerMsg(chatId, text, user.doc)
  } catch (e) {
    console.error('message handler xato:', e.message)
    safeSend(chatId, '⚠️ Xato yuz berdi. Qayta urinib ko\'ring.')
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  FIX #9: PIN — parallel qidiruv
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handlePin(chatId, text) {
  try {
    const [emp, drv] = await Promise.all([
      Employee.findOne({ pin: text }),
      Driver.findOne({ pin: text }),
    ])
    const found = emp || drv

    if (!found) {
      return safeSend(chatId,
        `❌ *Noto'g'ri PIN kod!*\n\nQayta urinib ko'ring yoki admindan yangi PIN oling.`
      )
    }

    if (found.tgChatId && found.tgChatId !== chatId) {
      return safeSend(chatId,
        `⚠️ Bu PIN allaqachon boshqa qurilmada ishlatilgan.\nAdmin bilan bog'laning.`
      )
    }

    await (emp
      ? Employee.findByIdAndUpdate(found._id, { tgChatId: chatId })
      : Driver.findByIdAndUpdate(found._id, { tgChatId: chatId })
    )

    const type = emp ? 'worker' : 'driver'
    delete sessions[chatId]

    await safeSend(chatId,
      `✅ *Xush kelibsiz, ${found.name}!*\n\n` +
      `${type === 'driver' ? '🚗 Shafyor' : '👷 Ishchi'} sifatida kirildi.\n\nQuyidagi menyudan foydalaning:`
    )

    const fresh = await (type === 'driver'
      ? Driver.findById(found._id).lean()
      : Employee.findById(found._id).lean()
    )
    return sendMainMenu(chatId, { type, doc: fresh })
  } catch (e) {
    console.error('handlePin xato:', e.message)
    safeSend(chatId, '⚠️ Tizimda xato. Qayta urinib ko\'ring.')
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  MAIN MENU
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function sendMainMenu(chatId, user) {
  if (user.type === 'driver') return sendDriverMenu(chatId, user.doc)
  if (user.type === 'worker') return sendWorkerMenu(chatId, user.doc)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DRIVER MENU
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function sendDriverMenu(chatId, driver) {
  try {
    const tasks = await Task.countDocuments({
      $or: [
        { driverId: driver._id },
        { driver: driver.name },
      ],
      status: { $in: ['yangi', 'jarayonda'] },
      deletedAt: { $exists: false },
    })

    safeSend(chatId,
      `🚗 *${driver.name}*\n\n` +
      `Holat: ${driver.status === 'faol' ? '🟢 Faol' : '🟡 ' + (driver.status||'')}\n` +
      `Faol topshiriqlar: *${tasks} ta*\n` +
      `Vaqt: ${nowT()}`,
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
  } catch (e) {
    console.error('sendDriverMenu:', e.message)
    safeSend(chatId, '⚠️ Menyu yuklashda xato.')
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  FIX #2: WORKER MENU — Attendance modeli
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function sendWorkerMenu(chatId, worker) {
  try {
    const [emp, att] = await Promise.all([
      Employee.findById(worker._id).select('name section balance').lean(),
      Attendance.findOne({ employeeId: String(worker._id), date: today() }).lean(),
    ])

    const isCheckedIn = att?.checkIn && !att?.checkOut

    safeSend(chatId,
      `👷 *${emp.name}*\n\n` +
      `Bo'lim: ${emp.section || '—'}\n` +
      `Balans: *${fc(emp.balance)}*\n` +
      `Bugun: ${att?.checkIn ? `✅ Kirdi ${att.checkIn}` : '❌ Kirmadi'}\n` +
      `Vaqt: ${nowT()}`,
      {
        reply_markup: {
          keyboard: [
            [
              { text: isCheckedIn ? '🚪 Ishdan chiqish' : '✅ Ishga kirdim' },
              { text: '📋 Topshiriqlarim' },
            ],
            [{ text: '💰 Balansim' }, { text: '📊 Oylik hisobot' }],
          ],
          resize_keyboard: true,
        }
      }
    )
  } catch (e) {
    console.error('sendWorkerMenu:', e.message)
    safeSend(chatId, '⚠️ Menyu yuklashda xato.')
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  FIX #8: DRIVER HANDLER — try/catch
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleDriverMsg(chatId, text, driver) {
  try {
    switch (text) {

      case '📋 Topshiriqlarim': {
        const tasks = await Task.find({
          $or: [{ driverId: driver._id }, { driver: driver.name }],
          deletedAt: { $exists: false },
          status: { $in: ['jarayonda', 'yangi'] },
        }).sort({ createdAt: -1 }).limit(10).lean()

        if (!tasks.length) {
          return safeSend(chatId, '📭 Hozircha topshiriq yo\'q.')
        }

        for (const t of tasks) {
          const mapUrl = t.lat && t.lon
            ? `https://maps.google.com/?q=${t.lat},${t.lon}`
            : `https://yandex.com/maps/?text=${encodeURIComponent(t.address || '')}`

          await safeSend(chatId,
            `${t.type === 'delivery' ? '📦' : '📮'} *${t.order || t.orderNumber || '—'}*\n` +
            `👤 ${t.customer || '—'}\n` +
            `📍 ${t.address || '—'}\n` +
            `📞 ${t.phone || '—'}\n` +
            `Holat: ${t.status}`,
            {
              reply_markup: {
                inline_keyboard: [[
                  { text: '🗺️ Xarita', url: mapUrl },
                  { text: '✅ Yetkazildi', callback_data: `driver_done:${t._id}` },
                ]]
              }
            }
          )
        }
        break
      }

      case '📍 Lokatsiyam': {
        safeSend(chatId,
          '📡 *GPS lokatsiyangizni yuboring:*\n\nPastdagi tugmani bosing.',
          {
            reply_markup: {
              keyboard: [
                [{ text: '📍 Lokatsiyamni yuborish', request_location: true }],
                [{ text: '🔙 Menyu' }],
              ],
              resize_keyboard: true,
            }
          }
        )
        break
      }

      case '✅ Topshirildi': {
        const tasks = await Task.find({
          $or: [{ driverId: driver._id }, { driver: driver.name }],
          status: { $in: ['yangi', 'jarayonda'] },
          deletedAt: { $exists: false },
        }).limit(5).lean()

        if (!tasks.length) return safeSend(chatId, 'Faol topshiriq yo\'q.')

        const buttons = tasks.map(t => ([{
          text: `${t.order || '?'} — ${t.customer || ''}`,
          callback_data: `driver_done:${t._id}`,
        }]))

        safeSend(chatId, '✅ Qaysi topshiriq yakunlandi?',
          { reply_markup: { inline_keyboard: buttons } }
        )
        break
      }

      case '📊 Statistika': {
        const monthStart = new Date(new Date().setDate(1))
        const [done, month] = await Promise.all([
          Task.countDocuments({
            $or: [{ driverId: driver._id }, { driver: driver.name }],
            status: 'yetkazildi', deletedAt: { $exists: false },
          }),
          Task.countDocuments({
            $or: [{ driverId: driver._id }, { driver: driver.name }],
            status: 'yetkazildi',
            createdAt: { $gte: monthStart },
            deletedAt: { $exists: false },
          }),
        ])

        safeSend(chatId,
          `📊 *${driver.name} — Statistika*\n\n` +
          `✅ Jami: ${done} ta\n` +
          `📅 Bu oy: ${month} ta`
        )
        break
      }

      case '🔙 Menyu':
      default:
        return sendDriverMenu(chatId, driver)
    }
  } catch (e) {
    console.error('handleDriverMsg xato:', e.message)
    safeSend(chatId, '⚠️ Xato yuz berdi. Qayta urinib ko\'ring.')
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  FIX #2 + #8: WORKER HANDLER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleWorkerMsg(chatId, text, worker) {
  try {
    switch (text) {

      // FIX #2: Attendance alohida modeldan
      case '✅ Ishga kirdim': {
        const todayStr = today()
        const existing = await Attendance.findOne({
          employeeId: String(worker._id), date: todayStr,
        })

        if (existing?.checkIn) {
          return safeSend(chatId,
            `✅ Siz bugun allaqachon kirdingiz: *${existing.checkIn}*`
          )
        }

        await Attendance.findOneAndUpdate(
          { employeeId: String(worker._id), date: todayStr },
          { $set: { employeeId: String(worker._id), date: todayStr, checkIn: nowT(), status: 'keldi' } },
          { upsert: true }
        )

        // Cache va real-time yangilash
        await invalidateCache(['attendance', 'dashboard'])
        broadcast('attendance')

        await safeSend(chatId,
          `✅ *Ishga kirdingiz!*\n\nVaqt: *${nowT()}*\nXayrli ish kuni! 💪`
        )
        const emp = await Employee.findById(worker._id).lean()
        return sendWorkerMenu(chatId, emp)
      }

      case '🚪 Ishdan chiqish': {
        const todayStr = today()
        const existing = await Attendance.findOne({
          employeeId: String(worker._id), date: todayStr,
        })

        if (!existing?.checkIn) {
          return safeSend(chatId, '⚠️ Bugun kirish qayd etilmagan.')
        }
        if (existing.checkOut) {
          return safeSend(chatId,
            `ℹ️ Siz allaqachon chiqdingiz: *${existing.checkOut}*`
          )
        }

        await Attendance.findByIdAndUpdate(existing._id, {
          $set: { checkOut: nowT() }
        })

        await invalidateCache(['attendance', 'dashboard'])
        broadcast('attendance')

        await safeSend(chatId,
          `🚪 *Ishdan chiqdingiz!*\n\n` +
          `Kirish: *${existing.checkIn}*\n` +
          `Chiqish: *${nowT()}*\n\nXayrli dam oling! 👋`
        )
        const emp = await Employee.findById(worker._id).lean()
        return sendWorkerMenu(chatId, emp)
      }

      // FIX #6: workerId — ObjectId va String ikkalasi qo'llab-quvvatlanadi
      case '📋 Topshiriqlarim': {
        const wid = String(worker._id)
        const items = await OrderItem.find({
          $or: [
            { 'assignments.workerId': wid },
            { 'assignments.workerId': worker._id },
          ],
          deletedAt: { $exists: false },
          stage: { $nin: ['tugallandi'] },
        }).limit(10).lean()

        const myItems = items.filter(item =>
          item.assignments?.some(a =>
            (String(a.workerId) === wid) && !a.doneAt
          )
        )

        if (!myItems.length) {
          return safeSend(chatId,
            '📭 Hozircha faol topshiriq yo\'q.\n\nYangi topshiriq kelganda xabar beriladi.'
          )
        }

        for (const item of myItems) {
          await safeSend(chatId,
            `📋 *${item.name}*\n` +
            `📦 Buyurtma: ${item.orderNumber || '—'}\n` +
            `📍 Bosqich: ${item.stage}\n` +
            `${item.unit === 'sqm' ? `📐 ${item.sqm} kv.m` : `🔢 ${item.qty} dona`}\n` +
            `💰 To'lov: ${fc(item.pricePerUnit)}/${item.unit === 'sqm' ? 'kv.m' : 'dona'}`,
            {
              reply_markup: {
                inline_keyboard: [[
                  { text: '✅ Bosqich tugallandi', callback_data: `worker_done:${item._id}` }
                ]]
              }
            }
          )
        }
        break
      }

      case '💰 Balansim': {
        const emp = await Employee.findById(worker._id)
          .select('name section balance advancePaid').lean()
        safeSend(chatId,
          `💰 *${emp.name} — Balans*\n\n` +
          `Joriy balans: *${fc(emp.balance)}*\n` +
          `Berilgan avans: *${fc(emp.advancePaid)}*\n` +
          `Bo'lim: ${emp.section || '—'}`
        )
        break
      }

      case '📊 Oylik hisobot': {
        const monthStart = new Date(new Date().setDate(1))
        const todayStr   = today()
        const [emp, workDays, doneItems] = await Promise.all([
          Employee.findById(worker._id).select('name balance').lean(),
          Attendance.countDocuments({
            employeeId: String(worker._id),
            date: { $gte: monthStart.toISOString().slice(0, 10) },
            checkIn: { $exists: true },
          }),
          OrderItem.find({
            $or: [
              { 'assignments.workerId': String(worker._id) },
              { 'assignments.workerId': worker._id },
            ],
            'assignments.doneAt': { $gte: monthStart },
          }).lean(),
        ])

        const earned = doneItems.reduce((s, i) => {
          const a = i.assignments?.find(a =>
            String(a.workerId) === String(worker._id) && a.doneAt && new Date(a.doneAt) >= monthStart
          )
          return s + (a?.earned || 0)
        }, 0)

        safeSend(chatId,
          `📊 *Bu oy — ${new Date().toLocaleString('uz-UZ', { month: 'long' })}*\n\n` +
          `✅ Ish kunlari: *${workDays} kun*\n` +
          `💰 Hisoblangan: *${fc(earned)}*\n` +
          `💳 Joriy balans: *${fc(emp.balance)}*`
        )
        break
      }

      default:
        return sendWorkerMenu(chatId, worker)
    }
  } catch (e) {
    console.error('handleWorkerMsg xato:', e.message)
    safeSend(chatId, '⚠️ Xato yuz berdi. Qayta urinib ko\'ring.')
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  LIVE LOCATION (GPS)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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
      accuracy:   location.horizontal_accuracy || 0,
      ts:         Date.now(),
      online:     true,
    }

    const cache = require('../redis/cache')
    await cache.set(`driver_loc:${chatId}`, JSON.stringify(data), 300)

    const io = global.__io
    if (io) io.emit('driver:live-location', data)
  } catch (e) {
    console.error('handleLiveLocation:', e.message)
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  CALLBACK QUERY
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.on('callback_query', async query => {
  const chatId = String(query.message.chat.id)
  const [action, id] = (query.data || '').split(':')

  try {
    await bot.answerCallbackQuery(query.id)
  } catch {}

  // FIX #4: driver_done — syncOrderStats + cache + broadcast
  if (action === 'driver_done') {
    try {
      const task = await Task.findById(id)
      if (!task) return safeSend(chatId, '⚠️ Topshiriq topilmadi.')

      task.status = 'yetkazildi'
      task.doneAt = new Date()
      await task.save()

      // Order statistikasini yangilash (cache + broadcast)
      if (task.orderId) {
        await syncOrderStats(task.orderId)
      } else {
        // orderId yo'q bo'lsa ham cache tozalash
        await invalidateCache(['orders', 'delivery', 'pickup', 'dashboard'])
        broadcast('orders')
      }

      bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: chatId, message_id: query.message.message_id,
      }).catch(() => {})

      safeSend(chatId,
        `✅ *Topshiriq yakunlandi!*\n\n` +
        `📦 ${task.order || ''}\n` +
        `👤 ${task.customer || ''}\n` +
        `Vaqt: ${nowT()}`
      )
    } catch (e) {
      console.error('driver_done xato:', e.message)
      safeSend(chatId, '⚠️ Topshiriqni yangilashda xato.')
    }
  }

  // worker_done — advanceOrderItem (services/orderSync.js)
  if (action === 'worker_done') {
    try {
      const worker = await Employee.findOne({ tgChatId: chatId }).lean()
      if (!worker) return safeSend(chatId, '⚠️ Ishchi topilmadi.')

      const { item, nextStage, earned } = await advanceOrderItem(id)

      bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: chatId, message_id: query.message.message_id,
      }).catch(() => {})

      safeSend(chatId,
        `✅ *${item.name}* — *${nextStage}* bosqichga o'tdi!\n` +
        (earned > 0 ? `💰 Balansingizga *${fc(earned)}* qo'shildi!` : '')
      )
    } catch (e) {
      const msg = e.status === 409
        ? 'Bu bosqich allaqachon yangilangan.'
        : (e.message || 'Topshiriqni yangilab bo\'lmadi.')
      safeSend(chatId, `⚠️ ${msg}`)
    }
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  EXPORT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function notifyDriver(driverName, message, inlineButtons) {
  try {
    const driver = await Driver.findOne({
      $or: [{ name: driverName }],
      tgChatId: { $exists: true, $ne: '' },
    })
    if (!driver?.tgChatId) return false
    await safeSend(driver.tgChatId, message,
      inlineButtons ? { reply_markup: { inline_keyboard: inlineButtons } } : {}
    )
    return true
  } catch (e) { console.error('notifyDriver:', e.message); return false }
}

async function notifyWorker(workerId, message, inlineButtons) {
  try {
    const worker = await Employee.findById(workerId)
    if (!worker?.tgChatId) return false
    await safeSend(worker.tgChatId, message,
      inlineButtons ? { reply_markup: { inline_keyboard: inlineButtons } } : {}
    )
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

// ── Xato ushlovchilar ──
bot.on('polling_error', err => console.error('🔴 Polling xato:', err.code, err.message))
bot.on('error',         err => console.error('🔴 Bot xato:', err.message))
process.on('unhandledRejection', r => console.error('🔴 unhandledRejection:', r))

module.exports = { bot, notifyDriver, notifyWorker, getAllLiveLocations }
