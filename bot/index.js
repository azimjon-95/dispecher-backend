// =============================================
//  DISPECHER BOT
//  Shafyor va ishchilar uchun Telegram Bot
//  Ishlatish: node bot/index.js
// =============================================
require('dotenv').config({ path: require('path').join(__dirname, '../.env') })
const TelegramBot = require('node-telegram-bot-api')
const mongoose    = require('mongoose')
const cache       = require('../redis/cache')

// ── Connect DB ──
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/dispecher')
  .then(() => console.log('✅ Bot: MongoDB connected'))
  .catch(e => console.error('❌ Bot MongoDB:', e.message))

const {
  Driver, Employee, Task, OrderItem, Order, Finance
} = require('../models')

// ── Init bot ──
const TOKEN = process.env.BOT_TOKEN
if (!TOKEN) { console.error('❌ BOT_TOKEN .env da yo\'q!'); process.exit(1) }

const bot = new TelegramBot(TOKEN, { polling: true })
console.log('🤖 Bot ishga tushdi...')

// ── Currency format ──
const fc = n => (n || 0).toLocaleString('ru-RU') + " so'm"

// ── Map link ──
function mapLink(lat, lon, addr) {
  if (lat && lon) return `https://yandex.com/maps/?ll=${lon},${lat}&z=16&pt=${lon},${lat},pm2rdm&l=map`
  return `https://yandex.com/maps/?text=${encodeURIComponent(addr||'')}`
}

// ── Live location map (shafyor o'z joyidan mijozga) ──
function routeLink(driverLat, driverLon, destLat, destLon, destAddr) {
  if (driverLat && driverLon && destLat && destLon) {
    return `https://yandex.com/maps/?rtext=${driverLat},${driverLon}~${destLat},${destLon}&rtt=auto`
  }
  if (destLat && destLon) {
    return `https://yandex.com/maps/?ll=${destLon},${destLat}&z=16&pt=${destLon},${destLat},pm2rdm`
  }
  return `https://yandex.com/maps/?text=${encodeURIComponent(destAddr||'')}`
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   /START — ROL ANIQLASH
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id
  const text   = msg.text || ''
  // deep link: /start driver_PHONE yoki /start worker_PHONE
  const parts  = text.split(' ')
  const param  = parts[1] || ''

  // Save chatId to DB
  if (param.startsWith('driver_')) {
    const phone = '+' + param.replace('driver_', '')
    const drv = await Driver.findOneAndUpdate({ phone }, { tgChatId: String(chatId) }, { new: true })
    if (drv) {
      await cache.set(`driver_chat:${drv._id}`, chatId, 86400 * 30)
      return bot.sendMessage(chatId,
        `✅ *Xush kelibsiz, ${drv.name}!*\n\nSiz shafyor sifatida ro'yxatdan o'tdingiz.\nTopshiriqlar shu yerga keladi.`,
        { parse_mode: 'Markdown' }
      )
    }
  }

  if (param.startsWith('worker_')) {
    const phone = '+' + param.replace('worker_', '')
    const emp = await Employee.findOneAndUpdate({ phone }, { tgChatId: String(chatId) }, { new: true })
    if (emp) {
      await cache.set(`worker_chat:${emp._id}`, chatId, 86400 * 30)
      return bot.sendMessage(chatId,
        `✅ *Xush kelibsiz, ${emp.name}!*\n\nSiz ishchi sifatida ro'yxatdan o'tdingiz.\nTopshiriqlar shu yerga keladi.`,
        { parse_mode: 'Markdown' }
      )
    }
  }

  // Default start
  bot.sendMessage(chatId,
    `👋 *Dispecher Bot*\n\nBu bot shafyor va ishchilar uchun.\nAdmin tomonidan havola berilishi kerak.`,
    { parse_mode: 'Markdown' }
  )
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   /menu — SHAFYOR MENYU
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.onText(/\/menu/, async (msg) => {
  const chatId  = String(msg.chat.id)
  const driver  = await Driver.findOne({ tgChatId: chatId })
  const worker  = await Employee.findOne({ tgChatId: chatId })

  if (driver) return sendDriverMenu(chatId, driver)
  if (worker) return sendWorkerMenu(chatId, worker)

  bot.sendMessage(msg.chat.id, '⚠️ Siz ro\'yxatdan o\'tmagansiz.')
})

async function sendDriverMenu(chatId, driver) {
  const active = await Task.countDocuments({ driver: driver.name, status: 'jarayonda', deletedAt: { $exists: false } })
  bot.sendMessage(chatId,
    `🚗 *${driver.name}*\n\nHolat: ${driver.status === 'faol' ? '🟢 Faol' : '🟡 ' + driver.status}\nFaol topshiriqlar: *${active} ta*`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [
          [{ text: '📋 Mening topshiriqlarim' }, { text: '📊 Mening statistikam' }],
          [{ text: '✅ Faol holatni yangilaish' }],
        ],
        resize_keyboard: true,
      }
    }
  )
}

async function sendWorkerMenu(chatId, worker) {
  const active = await OrderItem.countDocuments({
    'assignments.workerId': worker._id,
    'assignments.doneAt': null,
    deletedAt: { $exists: false }
  })
  bot.sendMessage(chatId,
    `👷 *${worker.name}*\n\nBo'lim: ${worker.section}\nFaol topshiriqlar: *${active} ta*`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [
          [{ text: '📋 Mening topshiriqlarim' }, { text: '💰 Balansim' }],
        ],
        resize_keyboard: true,
      }
    }
  )
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   INLINE CALLBACK HANDLER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.on('callback_query', async (query) => {
  const chatId = String(query.message.chat.id)
  const msgId  = query.message.message_id
  const data   = query.data || ''

  await bot.answerCallbackQuery(query.id)

  const [action, id] = data.split(':')

  // ── PICKUP ACCEPT ──
  if (action === 'pickup_accept') {
    const task = await Task.findById(id)
    if (!task) return bot.editMessageText('❌ Topshiriq topilmadi', { chat_id: chatId, message_id: msgId })

    await Task.findByIdAndUpdate(id, { status: 'jarayonda' })

    const mapUrl = routeLink(null, null, task.lat, task.lon, task.address)
    const items  = await OrderItem.find({ orderId: task.orderId, deletedAt: { $exists: false } })
    const itemsList = items.map((it, i) =>
      `  ${i+1}. 🏷️\`${it._id.toString().slice(-6).toUpperCase()}\` ${it.name} — ${it.unit==='sqm' ? it.sqm+'m²' : it.qty+' dona'}`
    ).join('\n')

    await bot.editMessageText(
      `✅ *Qabul qilindi!*\n\n📋 Topshiriq: \`${task.order}\`\n👤 ${task.customer}\n📞 ${task.phone}\n📍 ${task.address}\n\n📦 *Olib kelish:*\n${itemsList}\n\n🗺️ [Xaritada ko'rish](${mapUrl})`,
      {
        chat_id: chatId, message_id: msgId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '📦 Mijozdan qabul qildim', callback_data: `pickup_got:${id}` }
          ]]
        }
      }
    )
    // Admin ga xabar
    await notifyAdmin(`🟡 Shafyor pickup qabul qildi\nTopshiriq: ${task.order}\nShafyor: ${task.driver}`)
  }

  // ── PICKUP REJECT ──
  if (action === 'pickup_reject') {
    await Task.findByIdAndUpdate(id, { status: 'bekor', driver: '' })
    await bot.editMessageText('❌ Topshiriq bekor qilindi. Admin xabardor qilindi.', { chat_id: chatId, message_id: msgId })
    const task = await Task.findById(id)
    await notifyAdmin(`🔴 Shafyor pickup rad etdi\nTopshiriq: ${task?.order}\nShafyor: ${task?.driver}`)
  }

  // ── PICKUP GOT (Mijozdan qabul qilib oldi) ──
  if (action === 'pickup_got') {
    const task = await Task.findById(id)
    if (!task) return

    await bot.editMessageText(
      `✅ *Mijozdan qabul qilindi!*\n\n📋 ${task.order}\n👤 ${task.customer}\n\nEndi seksga olib keling.`,
      {
        chat_id: chatId, message_id: msgId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '🏭 Seksga olib keldim!', callback_data: `pickup_delivered:${id}` }
          ]]
        }
      }
    )
    await notifyAdmin(`📦 Shafyor mijozdan mahsulot oldi\nTopshiriq: ${task.order}`)
  }

  // ── PICKUP DELIVERED (Seksga olib keldi) ──
  if (action === 'pickup_delivered') {
    const task = await Task.findById(id)
    if (!task) return

    await Task.findByIdAndUpdate(id, { status: 'yetkazildi' })
    if (task.orderId) await Order.findByIdAndUpdate(task.orderId, { status: 'qabul_qilindi' })

    await bot.editMessageText(
      `🎉 *Topshiriq yakunlandi!*\n\n📋 ${task.order} seksga topshirildi.\n✅ Admin ko'rmoqda.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
    )
    await notifyAdmin(`✅ Shafyor seksga olib keldi\nBuyurtma: ${task.order}\nEndi ishchilar ishlaydi`)
  }

  // ── DELIVERY ACCEPT ──
  if (action === 'delivery_accept') {
    const task = await Task.findById(id)
    if (!task) return bot.editMessageText('❌ Topilmadi', { chat_id: chatId, message_id: msgId })

    await Task.findByIdAndUpdate(id, { status: 'jarayonda' })
    const mapUrl = routeLink(null, null, task.lat, task.lon, task.address)

    // Items with codes
    const items = await OrderItem.find({ orderId: task.orderId, deletedAt: { $exists: false } })
    const itemsList = items.map((it, i) =>
      `  ${i+1}. 🏷️\`${it._id.toString().slice(-6).toUpperCase()}\` ${it.name}`
    ).join('\n')

    await bot.editMessageText(
      `✅ *Qabul qilindi — Yetkazib berish!*\n\n📋 Buyurtma: \`${task.order}\`\n👤 *${task.customer}*\n📞 ${task.phone}\n📍 ${task.address}\n\n📦 *Mahsulotlar:*\n${itemsList}\n\n💰 To'lov: *${fc(task.totalPrice)}*\n${task.paid ? '✅ To\'langan' : `⚠️ Yig'ib oling: *${fc(task.amountDue)}*`}\n\n🗺️ [Yo'l xaritada](${mapUrl})`,
      {
        chat_id: chatId, message_id: msgId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Topshirdim, pul oldim', callback_data: `delivery_done_cash:${id}` },
            { text: '💳 Topshirdim (karta)', callback_data: `delivery_done_card:${id}` },
          ], [
            { text: '⚠️ Mijoz uyda yo\'q', callback_data: `delivery_nobody:${id}` }
          ]]
        }
      }
    )
    await notifyAdmin(`🟡 Shafyor delivery qabul qildi\nTopshiriq: ${task.order}`)
  }

  // ── DELIVERY REJECT ──
  if (action === 'delivery_reject') {
    await Task.findByIdAndUpdate(id, { status: 'yangi', driver: '' })
    await bot.editMessageText('❌ Rad etildi. Admin topshiriqni qayta belgilaydi.', { chat_id: chatId, message_id: msgId })
    const task = await Task.findById(id)
    await notifyAdmin(`🔴 Shafyor delivery rad etdi\nBuyurtma: ${task?.order}`)
  }

  // ── DELIVERY DONE CASH ──
  if (action === 'delivery_done_cash') {
    await handleDeliveryDone(id, chatId, msgId, 'naqt')
  }

  // ── DELIVERY DONE CARD ──
  if (action === 'delivery_done_card') {
    await handleDeliveryDone(id, chatId, msgId, 'karta')
  }

  // ── DELIVERY NOBODY ──
  if (action === 'delivery_nobody') {
    const task = await Task.findById(id)
    await Task.findByIdAndUpdate(id, { status: 'yangi' })
    await bot.editMessageText(
      `⚠️ Admin xabardor qilindi.\nMijoz uyda yo'q — ${task?.order}`,
      { chat_id: chatId, message_id: msgId }
    )
    await notifyAdmin(`⚠️ Shafyor yetdi lekin mijoz uyda yo'q\nBuyurtma: ${task?.order}\nMijoz: ${task?.customer} ${task?.phone}`)
  }

  // ── ITEM DONE (ishchi bajardi) ──
  if (action === 'item_done') {
    const item = await OrderItem.findById(id)
    if (!item) return bot.editMessageText('❌ Topilmadi', { chat_id: chatId, message_id: msgId })

    const NEXT = { yuvish:'quritish', quritish:'bezak', bezak:'yetkazish', yetkazish:'tugallandi' }
    const nextStage = NEXT[item.stage]

    // Mark done
    const cur = item.assignments?.find(a => a.stage === item.stage && !a.doneAt)
    if (cur) cur.doneAt = new Date()
    if (nextStage) item.stage = nextStage

    // Worker balance
    if (cur?.workerId) {
      const earn = item.unit === 'sqm'
        ? Math.round((item.sqm || 0) * 1500)
        : Math.round((item.qty || 1) * 2000)
      await Employee.findByIdAndUpdate(cur.workerId, { $inc: { balance: earn } })
    }

    await item.save()

    const STAGE_LABEL = {
      yuvish:'🫧 Yuvish', quritish:'💨 Quritish', bezak:'✨ Bezak',
      yetkazish:'🚚 Yetkazish', tugallandi:'✅ Tugallandi'
    }
    const nextLabel = STAGE_LABEL[nextStage] || 'Tugallandi'

    await bot.editMessageText(
      `✅ *Bajarildi!*\n\n${item.name}\n📋 Buyurtma: \`${item.orderNumber}\`\n\n➡️ Keyingi bosqich: *${nextLabel}*`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
    )
    await notifyAdmin(`✅ Ishchi bajardi: ${item.name} → ${nextLabel}\nBuyurtma: ${item.orderNumber}`)
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   DELIVERY DONE HANDLER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleDeliveryDone(taskId, chatId, msgId, payMethod) {
  const task = await Task.findById(taskId)
  if (!task) return

  await Task.findByIdAndUpdate(taskId, { status: 'yetkazildi', payMethod })

  if (task.orderId) {
    await Order.findByIdAndUpdate(task.orderId, { status: 'tugallandi' })

    // Finance: kirim qo'shish (agar naqt)
    if (payMethod === 'naqt' && task.amountDue > 0) {
      await Finance.create({
        type:        'kirim',
        description: `Buyurtma ${task.order} — naqt to'lov (shafyor)`,
        amount:      task.amountDue,
        category:    'Buyurtma',
        orderId:     task.orderId,
        by:          task.driver,
        date:        new Date().toISOString().slice(0, 10),
      })
    }
  }

  await bot.editMessageText(
    `🎉 *Topshiriq yakunlandi!*\n\n📋 ${task.order}\n👤 ${task.customer}\n💰 To'lov: ${payMethod === 'naqt' ? '💵 Naqt' : '💳 Karta'}\nSumma: ${fc(task.amountDue || task.totalPrice)}\n\n✅ Kassaga topshiring!`,
    { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '💵 Kassaga topshirdim', callback_data: `cash_submitted:${taskId}` }
        ]]
      }
    }
  )
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   CASH SUBMITTED
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.on('callback_query', async (query) => {
  const chatId = String(query.message.chat.id)
  const msgId  = query.message.message_id
  const data   = query.data || ''

  if (data.startsWith('cash_submitted:')) {
    const id   = data.split(':')[1]
    const task = await Task.findById(id)
    await bot.editMessageText(
      `✅ *Pul kassaga topshirildi!*\n\nRahmat, ${task?.driver || 'shafyor'}!`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
    )
    await notifyAdmin(`💵 Shafyor kassaga pul topshirdi\nBuyurtma: ${task?.order}\nSumma: ${fc(task?.amountDue)}`)
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   TEXT MESSAGES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
bot.on('message', async (msg) => {
  if (msg.text?.startsWith('/')) return

  const chatId = String(msg.chat.id)
  const text   = msg.text || ''

  const driver = await Driver.findOne({ tgChatId: chatId })
  const worker = await Employee.findOne({ tgChatId: chatId })

  // ── Mening topshiriqlarim ──
  if (text === '📋 Mening topshiriqlarim') {
    if (driver) return await sendDriverTasks(chatId, driver)
    if (worker) return await sendWorkerTasks(chatId, worker)
  }

  // ── Statistika ──
  if (text === '📊 Mening statistikam' && driver) {
    return await sendDriverStats(chatId, driver)
  }

  // ── Balans ──
  if (text === '💰 Balansim' && worker) {
    return await sendWorkerBalance(chatId, worker)
  }
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   DRIVER TASKS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function sendDriverTasks(chatId, driver) {
  const tasks = await Task.find({
    driver: driver.name,
    status: { $in: ['yangi', 'jarayonda'] },
    deletedAt: { $exists: false }
  }).sort({ createdAt: -1 }).limit(10)

  if (!tasks.length) {
    return bot.sendMessage(chatId, '📭 Hozircha faol topshiriq yo\'q.')
  }

  const list = tasks.map(t => {
    const icon = t.type === 'pickup' ? '📮' : '🚚'
    return `${icon} \`${t.order}\` — ${t.customer} (${t.status})`
  }).join('\n')

  bot.sendMessage(chatId, `📋 *Faol topshiriqlaringiz:*\n\n${list}`, { parse_mode: 'Markdown' })
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   DRIVER STATISTICS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function sendDriverStats(chatId, driver) {
  const [totalTrips, thisMonth, totalEarned] = await Promise.all([
    Task.countDocuments({ driver: driver.name, status: 'yetkazildi' }),
    Task.countDocuments({
      driver: driver.name, status: 'yetkazildi',
      createdAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) }
    }),
    Finance.aggregate([
      { $match: { by: driver.name, type: 'kirim' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ])
  ])

  const earned = totalEarned[0]?.total || 0

  bot.sendMessage(chatId,
    `📊 *Sizning statistikangiz*\n\n🚗 Jami yetkazishlar: *${totalTrips} ta*\n📅 Bu oy: *${thisMonth} ta*\n💰 Yig'ilgan: *${fc(earned)}*\n\n✅ Davom eting!`,
    { parse_mode: 'Markdown' }
  )
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   WORKER TASKS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function sendWorkerTasks(chatId, worker) {
  const items = await OrderItem.find({
    'assignments': { $elemMatch: { workerId: worker._id, doneAt: null } },
    deletedAt: { $exists: false }
  }).sort({ createdAt: -1 }).limit(10)

  if (!items.length) {
    return bot.sendMessage(chatId, '📭 Hozircha faol topshiriq yo\'q.')
  }

  const list = items.map(i => {
    const ICON = { yuvish:'🫧', quritish:'💨', bezak:'✨' }
    return `${ICON[i.stage]||'📦'} \`${i.orderNumber}\` — ${i.name} (${i.stage})`
  }).join('\n')

  bot.sendMessage(chatId, `📋 *Faol topshiriqlaringiz:*\n\n${list}`, { parse_mode: 'Markdown' })
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   WORKER BALANCE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function sendWorkerBalance(chatId, worker) {
  const fresh = await Employee.findById(worker._id)
  const done  = await OrderItem.countDocuments({
    'assignments': { $elemMatch: { workerId: worker._id, doneAt: { $ne: null } } }
  })

  bot.sendMessage(chatId,
    `💰 *Sizning balansingiz*\n\n✅ Bajarilgan mahsulotlar: *${done} ta*\n💵 To'plangan balans: *${fc(fresh?.balance || 0)}*\n📅 Bazaviy oylik: *${fc(fresh?.salary || 0)}*\n\n💡 Oylik hisob-kitobda balansingiz qo'shiladi.`,
    { parse_mode: 'Markdown' }
  )
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//   ADMIN NOTIFY
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function notifyAdmin(text) {
  const adminChatId = process.env.ADMIN_CHAT_ID
  if (!adminChatId) return
  try {
    await bot.sendMessage(adminChatId, `🔔 *Admin xabarnomasi*\n\n${text}`, { parse_mode: 'Markdown' })
  } catch (e) {}
}

// ── Error handling ──
bot.on('polling_error', e => console.error('Bot polling error:', e.message))

console.log('🤖 Bot polling ishlamoqda...')
