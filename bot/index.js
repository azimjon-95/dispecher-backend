// =============================================
//  TARTIB CRM BOT v3
//  PIN code ro'yxatdan o'tish
//  Kategoriya: Ishchi | Shafyor | Elektrik | Boshqa
//  GPS live location (shafyor)
//  Davomat (ishchi)
//  Buyurtma qabul (shafyor)
// =============================================
require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

// ── VPN Proxy (lokal test uchun, Rossiya/bloklangan tarmoqda) ──
if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.SOCKS_PROXY) {
  try {
    require('global-agent/bootstrap')
    const proxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.SOCKS_PROXY
    process.env.GLOBAL_AGENT_HTTP_PROXY  = proxy
    process.env.GLOBAL_AGENT_HTTPS_PROXY = proxy
    console.log('🔒 VPN Proxy:', proxy)
  } catch {
    console.warn('⚠️  global-agent topilmadi: npm install global-agent')
  }
}

const TelegramBot = require('node-telegram-bot-api')
const mongoose    = require('mongoose')

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Bot: MongoDB ulandi'))
  .catch(e => console.error('❌ Bot DB:', e.message))

const { Driver, Employee, Order, OrderItem, Task, Finance } = require('../models')

const TOKEN = process.env.BOT_TOKEN
if (!TOKEN) { console.error('❌ BOT_TOKEN yo\'q!'); process.exit(1) }

const bot = new TelegramBot(TOKEN, { polling: true })
console.log('🤖 Tartib CRM Bot ishga tushdi...')

// ── Helpers ──
const fc  = n => (n||0).toLocaleString('ru-RU') + " so'm"
const now = () => new Date().toLocaleTimeString('uz-UZ',{hour:'2-digit',minute:'2-digit'})
const today = () => new Date().toISOString().slice(0,10)

// ── PIN sessions ── (chatId → state)
const sessions = {}

// ── Role labels ──
const ROLES = {
  driver:   { label:'🚗 Shafyor',   emoji:'🚗' },
  worker:   { label:'👷 Ishchi',    emoji:'👷' },
  electric: { label:'⚡ Elektrik',  emoji:'⚡' },
  cleaning: { label:'🧹 Tozalovchi',emoji:'🧹' },
  other:    { label:'👤 Boshqa',    emoji:'👤' },
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   FIND USER by chatId
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function findUser(chatId) {
  const cid = String(chatId)
  const driver = await Driver.findOne({ tgChatId: cid })
  if (driver) return { type: 'driver', doc: driver }
  const worker = await Employee.findOne({ tgChatId: cid })
  if (worker) return { type: 'worker', doc: worker }
  return null
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   /start
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.onText(/\/start/, async msg => {
  const chatId = String(msg.chat.id)
  const user   = await findUser(chatId)

  if (user) {
    return sendMainMenu(chatId, user)
  }

  // Not registered → ask PIN
  sessions[chatId] = { step: 'pin' }
  bot.sendMessage(chatId,
    `👋 *Xush kelibsiz — Tartib CRM*\n\n` +
    `Tizimga kirish uchun *4 xonali PIN kodingizni* yuboring.\n\n` +
    `📌 PIN kodni admindan oling.`,
    {
      parse_mode: 'Markdown',
      reply_markup: { remove_keyboard: true }
    }
  )
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   MESSAGE HANDLER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.on('message', async msg => {
  const chatId  = String(msg.chat.id)
  const text    = (msg.text || '').trim()
  const sess    = sessions[chatId] || {}

  // Ignore commands (handled separately)
  if (text.startsWith('/')) return

  // ── Live location from driver ──
  if (msg.location) {
    return handleLiveLocation(chatId, msg.location)
  }

  // ── PIN step ──
  if (sess.step === 'pin') {
    return handlePin(chatId, text, msg)
  }

  // ── Registered user ──
  const user = await findUser(chatId)
  if (!user) {
    sessions[chatId] = { step: 'pin' }
    return bot.sendMessage(chatId, '⚠️ PIN kodingizni kiriting:')
  }

  // Route by role and text
  if (user.type === 'driver') return handleDriverMsg(chatId, text, user.doc, msg)
  if (user.type === 'worker') return handleWorkerMsg(chatId, text, user.doc, msg)
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   PIN HANDLER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handlePin(chatId, text, msg) {
  const sess = sessions[chatId] || {}

  // Step 1: verify PIN
  if (sess.step === 'pin') {
    // Find employee or driver with this PIN
    const emp = await Employee.findOne({ pin: text })
    const drv = await Driver.findOne({ pin: text })
    const found = emp || drv

    if (!found) {
      return bot.sendMessage(chatId,
        `❌ *Noto'g'ri PIN kod!*\n\nQayta urinib ko'ring yoki admindan yangi PIN oling.`,
        { parse_mode: 'Markdown' }
      )
    }

    // Already has chatId?
    if (found.tgChatId && found.tgChatId !== chatId) {
      return bot.sendMessage(chatId,
        `⚠️ Bu PIN allaqachon boshqa qurilmada ishlatilgan.\nAdmin bilan bog'laning.`
      )
    }

    // Link chatId
    found.tgChatId = chatId
    await found.save()

    const type = emp ? 'worker' : 'driver'
    const user = { type, doc: found }

    delete sessions[chatId]

    await bot.sendMessage(chatId,
      `✅ *Xush kelibsiz, ${found.name}!*\n\n` +
      `${type === 'driver' ? '🚗 Shafyor' : '👷 Ishchi'} sifatida ro'yxatdan o'tdingiz.\n\n` +
      `Quyidagi menyudan foydalaning:`,
      { parse_mode: 'Markdown' }
    )

    return sendMainMenu(chatId, user)
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   MAIN MENU
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function sendMainMenu(chatId, user) {
  if (user.type === 'driver') return sendDriverMenu(chatId, user.doc)
  if (user.type === 'worker') return sendWorkerMenu(chatId, user.doc)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   DRIVER MENU
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function sendDriverMenu(chatId, driver) {
  const tasks = await Task.countDocuments({
    driver: driver.name, status: 'jarayonda',
    deletedAt: { $exists: false }
  })

  bot.sendMessage(chatId,
    `🚗 *${driver.name}*\n\n` +
    `Holat: ${driver.status === 'faol' ? '🟢 Faol' : '🟡 ' + (driver.status||'')}\n` +
    `Faol topshiriqlar: *${tasks} ta*\n` +
    `Vaqt: ${now()}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [
          [{ text: '📋 Topshiriqlarim' }, { text: '📍 Lokatsiyam' }],
          [{ text: '✅ Topshirildi' }, { text: '📊 Statistika' }],
          [{ text: '📡 Live GPS yoqish', request_location: true }],
        ],
        resize_keyboard: true,
      }
    }
  )
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   WORKER MENU
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function sendWorkerMenu(chatId, worker) {
  const todayAtt = await Employee.findById(worker._id)
    .select('attendance').lean()
  const att = todayAtt?.attendance?.find?.(a => a.date === today())
  const isCheckedIn = att && att.checkIn && !att.checkOut

  bot.sendMessage(chatId,
    `👷 *${worker.name}*\n\n` +
    `Bo'lim: ${worker.section || '—'}\n` +
    `Balans: *${fc(worker.balance)}*\n` +
    `Bugun: ${att?.checkIn ? `✅ Kirdi ${att.checkIn}` : '❌ Kirmadi'}\n` +
    `Vaqt: ${now()}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [
          [
            { text: isCheckedIn ? '🚪 Ishdan chiqish' : '✅ Ishga kirdim' },
            { text: '📋 Topshiriqlarim' }
          ],
          [{ text: '💰 Balansim' }, { text: '📊 Oylik hisobot' }],
        ],
        resize_keyboard: true,
      }
    }
  )
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   DRIVER MESSAGE HANDLER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleDriverMsg(chatId, text, driver, msg) {
  switch (text) {

    case '📋 Topshiriqlarim': {
      const tasks = await Task.find({
        driver: driver.name,
        deletedAt: { $exists: false },
        status: { $in: ['jarayonda','yangi'] }
      }).sort({ createdAt: -1 }).limit(10).lean()

      if (!tasks.length) {
        return bot.sendMessage(chatId, '📭 Hozircha topshiriq yo\'q.')
      }

      for (const t of tasks) {
        const statusEmoji = t.type==='delivery' ? '📦' : '📮'
        const mapUrl = t.lat && t.lon
          ? `https://maps.google.com/?q=${t.lat},${t.lon}`
          : `https://yandex.com/maps/?text=${encodeURIComponent(t.address||'')}`

        await bot.sendMessage(chatId,
          `${statusEmoji} *${t.order || t.orderNumber}*\n` +
          `👤 ${t.customer}\n` +
          `📍 ${t.address || '—'}\n` +
          `📞 ${t.phone || '—'}\n` +
          `Holat: ${t.status}`,
          {
            parse_mode: 'Markdown',
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
      bot.sendMessage(chatId,
        '📡 *GPS lokatsiyangizni yuboring:*\n\n' +
        'Pastdagi tugmani bosing yoki menyudan "📡 Live GPS" tanlang.',
        {
          parse_mode: 'Markdown',
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
        driver: driver.name, status: 'jarayonda',
        deletedAt: { $exists: false }
      }).limit(5).lean()

      if (!tasks.length) return bot.sendMessage(chatId, 'Faol topshiriq yo\'q.')

      const buttons = tasks.map(t => ([{
        text: `${t.order||'?'} — ${t.customer||''}`,
        callback_data: `driver_done:${t._id}`
      }]))

      bot.sendMessage(chatId, '✅ Qaysi topshiriq yakunlandi?',
        { reply_markup: { inline_keyboard: buttons } }
      )
      break
    }

    case '📊 Statistika': {
      const done  = await Task.countDocuments({ driver: driver.name, status: 'yetkazildi', deletedAt: { $exists: false } })
      const month = await Task.countDocuments({
        driver: driver.name, status: 'yetkazildi',
        createdAt: { $gte: new Date(new Date().setDate(1)) },
        deletedAt: { $exists: false }
      })
      bot.sendMessage(chatId,
        `📊 *${driver.name} — Statistika*\n\n` +
        `✅ Jami: ${done} ta\n` +
        `📅 Bu oy: ${month} ta`,
        { parse_mode: 'Markdown' }
      )
      break
    }

    case '🔙 Menyu':
      return sendDriverMenu(chatId, driver)

    default:
      return sendDriverMenu(chatId, driver)
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   WORKER MESSAGE HANDLER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleWorkerMsg(chatId, text, worker, msg) {
  switch (text) {

    case '✅ Ishga kirdim': {
      const emp   = await Employee.findById(worker._id)
      const todayStr = today()
      let att = emp.attendance || []
      const existing = att.find(a => a.date === todayStr)

      if (existing?.checkIn) {
        return bot.sendMessage(chatId,
          `✅ Siz bugun allaqachon kirdingiz: *${existing.checkIn}*`,
          { parse_mode: 'Markdown' }
        )
      }

      if (!existing) {
        att.push({ date: todayStr, checkIn: now(), checkOut: null })
      } else {
        existing.checkIn = now()
      }
      emp.attendance = att
      await emp.save()

      bot.sendMessage(chatId,
        `✅ *Ishga kirdingiz!*\n\nVaqt: *${now()}*\nXayrli ish kuni! 💪`,
        { parse_mode: 'Markdown' }
      )
      return sendWorkerMenu(chatId, emp)
    }

    case '🚪 Ishdan chiqish': {
      const emp    = await Employee.findById(worker._id)
      const todayStr = today()
      const att    = emp.attendance || []
      const existing = att.find(a => a.date === todayStr)

      if (!existing?.checkIn) {
        return bot.sendMessage(chatId, '⚠️ Bugun kirish qayd etilmagan.')
      }
      if (existing.checkOut) {
        return bot.sendMessage(chatId,
          `ℹ️ Siz allaqachon chiqdingiz: *${existing.checkOut}*`,
          { parse_mode: 'Markdown' }
        )
      }

      existing.checkOut = now()
      emp.attendance = att
      await emp.save()

      bot.sendMessage(chatId,
        `🚪 *Ishdan chiqdingiz!*\n\nKirish: *${existing.checkIn}*\nChiqish: *${existing.checkOut}*\n\nXayrli dam oling! 👋`,
        { parse_mode: 'Markdown' }
      )
      return sendWorkerMenu(chatId, emp)
    }

    case '📋 Topshiriqlarim': {
      const items = await OrderItem.find({
        'assignments.workerId': worker._id.toString(),
        deletedAt: { $exists: false },
        stage: { $nin: ['tugallandi'] }
      }).limit(10).lean()

      if (!items.length) {
        return bot.sendMessage(chatId,
          '📭 Hozircha faol topshiriq yo\'q.\n\nYangi topshiriq kelganda xabar beriladi.'
        )
      }

      for (const item of items) {
        const myAss = item.assignments?.find?.(a =>
          String(a.workerId) === String(worker._id) && !a.doneAt
        )
        if (!myAss) continue

        await bot.sendMessage(chatId,
          `📋 *${item.name}*\n` +
          `📦 Buyurtma: ${item.orderNumber || '—'}\n` +
          `📍 Bosqich: ${item.stage}\n` +
          `${item.unit==='sqm' ? `📐 ${item.sqm} kv.m` : `🔢 ${item.qty} dona`}\n` +
          `💰 To'lov: ${fc(item.pricePerUnit)}/${item.unit==='sqm'?'kv.m':'dona'}`,
          {
            parse_mode: 'Markdown',
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
      const emp = await Employee.findById(worker._id).lean()
      bot.sendMessage(chatId,
        `💰 *${emp.name} — Balans*\n\n` +
        `Joriy balans: *${fc(emp.balance)}*\n` +
        `Berilgan avans: *${fc(emp.advancePaid)}*\n` +
        `Bo'lim: ${emp.section || '—'}`,
        { parse_mode: 'Markdown' }
      )
      break
    }

    case '📊 Oylik hisobot': {
      const emp   = await Employee.findById(worker._id).lean()
      const start = new Date(new Date().setDate(1))
      const doneItems = await OrderItem.find({
        'assignments': {
          $elemMatch: {
            workerId: worker._id.toString(),
            doneAt: { $gte: start }
          }
        }
      }).lean()

      const earned = doneItems.reduce((s,i) => {
        const a = i.assignments?.find?.(a => String(a.workerId)===String(worker._id)&&a.doneAt)
        return s + (a?.earned || 0)
      }, 0)

      const todayAtt = emp.attendance?.filter?.(a => {
        const d = new Date(a.date)
        return d >= start && a.checkIn
      }).length || 0

      bot.sendMessage(chatId,
        `📊 *Bu oy — ${new Date().toLocaleString('uz-UZ',{month:'long'})}*\n\n` +
        `✅ Ish kunlari: *${todayAtt} kun*\n` +
        `💰 Hisoblangan: *${fc(earned)}*\n` +
        `💳 Joriy balans: *${fc(emp.balance)}*`,
        { parse_mode: 'Markdown' }
      )
      break
    }

    default:
      return sendWorkerMenu(chatId, worker)
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   LIVE LOCATION (GPS)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleLiveLocation(chatId, location) {
  const driver = await Driver.findOne({ tgChatId: chatId })
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

  // Save to cache (Redis or memory)
  try {
    const cache = require('../redis/cache')
    await cache.set(`driver_loc:${chatId}`, JSON.stringify(data), 300)
    await cache.set(`driver_loc_all:${chatId}`, JSON.stringify(data), 300)
  } catch {}

  // GPS faqat Redis da saqlanadi — DB ga yozilmaydi (tezlik uchun)
  // Driver.lastLocation DB ga saqlanmaydi, faqat cache orqali olinadi

  // Emit to WebSocket if available
  try {
    const io = global.__io
    if (io) io.emit('driver:live-location', data)
  } catch {}
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   CALLBACK QUERY
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.on('callback_query', async query => {
  const chatId = String(query.message.chat.id)
  const data   = query.data || ''
  await bot.answerCallbackQuery(query.id)

  const [action, id] = data.split(':')

  // ── Driver: task done ──
  if (action === 'driver_done') {
    const task = await Task.findById(id)
    if (!task) return bot.sendMessage(chatId, '⚠️ Topshiriq topilmadi.')

    task.status = 'yetkazildi'
    task.doneAt = new Date()
    await task.save()

    // Update order status
    if (task.orderId) {
      await Order.findByIdAndUpdate(task.orderId, {
        status: task.type === 'delivery' ? 'tugallandi' : 'yetkazishda'
      })
    }

    bot.editMessageReplyMarkup({ inline_keyboard:[] }, {
      chat_id: chatId, message_id: query.message.message_id
    }).catch(()=>{})

    bot.sendMessage(chatId,
      `✅ *Topshiriq yakunlandi!*\n\n📦 ${task.order || ''}\n👤 ${task.customer || ''}\nVaqt: ${now()}`,
      { parse_mode: 'Markdown' }
    )
  }

  // ── Worker: item advance ──
  if (action === 'worker_done') {
    const item = await OrderItem.findById(id)
    if (!item) return bot.sendMessage(chatId, '⚠️ Topshiriq topilmadi.')

    const worker  = await Employee.findOne({ tgChatId: chatId })
    if (!worker) return

    const NEXT = {
      qabul:'yuvish', yuvish:'quritish', quritish:'bezak',
      bezak:'yetkazish', yetkazish:'tugallandi'
    }
    const EARN = { yuvish:1500, quritish:800, bezak:1000 }

    const myAss = item.assignments?.find?.(
      a => String(a.workerId)===String(worker._id) && !a.doneAt
    )
    if (myAss) {
      myAss.doneAt = new Date()
      myAss.earned = EARN[item.stage]
        ? Math.round((item.sqm||item.qty||1) * EARN[item.stage])
        : 0
    }

    const nextStage = NEXT[item.stage] || 'tugallandi'
    item.stage = nextStage

    // Worker balance
    if (myAss?.earned > 0) {
      await Employee.findByIdAndUpdate(worker._id, {
        $inc: { balance: myAss.earned }
      })
    }
    await item.save()

    bot.editMessageReplyMarkup({ inline_keyboard:[] }, {
      chat_id: chatId, message_id: query.message.message_id
    }).catch(()=>{})

    bot.sendMessage(chatId,
      `✅ *${item.name}* — ${item.stage} bosqichga o'tdi!\n` +
      (myAss?.earned > 0 ? `💰 Balansingizga *${fc(myAss.earned)}* qo'shildi!` : ''),
      { parse_mode: 'Markdown' }
    )
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   EXPORT: notify functions for routes
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function notifyDriver(driverName, message, inlineButtons) {
  try {
    const driver = await Driver.findOne({ name: driverName, tgChatId: { $exists: true, $ne: '' } })
    if (!driver?.tgChatId) return false
    await bot.sendMessage(driver.tgChatId, message, {
      parse_mode: 'Markdown',
      ...(inlineButtons ? { reply_markup: { inline_keyboard: inlineButtons } } : {})
    })
    return true
  } catch(e) { console.error('notifyDriver:', e.message); return false }
}

async function notifyWorker(workerId, message, inlineButtons) {
  try {
    const worker = await Employee.findById(workerId)
    if (!worker?.tgChatId) return false
    await bot.sendMessage(worker.tgChatId, message, {
      parse_mode: 'Markdown',
      ...(inlineButtons ? { reply_markup: { inline_keyboard: inlineButtons } } : {})
    })
    return true
  } catch(e) { console.error('notifyWorker:', e.message); return false }
}

// Live locations API endpoint
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

module.exports = { bot, notifyDriver, notifyWorker, getAllLiveLocations }
