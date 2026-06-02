// =============================================
//  TELEGRAM NOTIFICATION SERVICE
//  Bot orqali xabar yuborish
// =============================================
let bot = null

function getBot() {
  if (bot) return bot
  if (!process.env.BOT_TOKEN) return null
  try {
    const TelegramBot = require('node-telegram-bot-api')
    bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false })
    return bot
  } catch { return null }
}

// ── Yandex map link ──
function mapLink(lat, lon, address) {
  if (lat && lon) return `https://yandex.com/maps/?ll=${lon},${lat}&z=16&pt=${lon},${lat},pm2rdm`
  if (address) return `https://yandex.com/maps/?text=${encodeURIComponent(address)}`
  return null
}

// ── Format currency ──
const fc = n => (n || 0).toLocaleString('ru-RU') + " so'm"

// ======================================================
//   SHAFYOR — OLIB KELISH XABARI (Pickup)
// ======================================================
async function sendPickupToDriver(chatId, task) {
  const b = getBot()
  if (!b || !chatId) return false

  const mapBtn = (task.lat && task.lon) || task.address
    ? `\n\n🗺️ Xaritada ko'rish:\n${mapLink(task.lat, task.lon, task.address)}`
    : ''

  const itemsList = (task.items || []).map((item, i) =>
    `  ${i+1}. ${item.name} — ${item.unit==='sqm' ? `${item.sqm} kv.m` : `${item.qty} dona`}`
  ).join('\n')

  const text =
`🚗 *YANGI TOPSHIRIQ — OLIB KELISH*

📋 ID: \`${task.taskId || task._id}\`
━━━━━━━━━━━━━━━━━━
👤 *Mijoz:* ${task.customer}
📞 *Tel:* ${task.phone}
📍 *Manzil:* ${task.address}
━━━━━━━━━━━━━━━━━━
📦 *Olib kelish kerak:*
${itemsList || '  (Batafsil keyinroq)'}
━━━━━━━━━━━━━━━━━━${mapBtn}

*Qabul qilasizmi?*`

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Qabul qildim', callback_data: `pickup_accept:${task.taskId || task._id}` },
      { text: '❌ Qabul qila olmayman', callback_data: `pickup_reject:${task.taskId || task._id}` },
    ]]
  }

  try {
    await b.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard })
    return true
  } catch (e) {
    console.error('TG sendPickup error:', e.message)
    return false
  }
}

// ======================================================
//   SHAFYOR — YETKAZIB BERISH XABARI (Delivery)
// ======================================================
async function sendDeliveryToDriver(chatId, task) {
  const b = getBot()
  if (!b || !chatId) return false

  const mapBtn = (task.lat && task.lon) || task.address
    ? `\n🗺️ Xaritada:\n${mapLink(task.lat, task.lon, task.address)}`
    : ''

  const itemsList = (task.items || []).map((item, i) =>
    `  ${i+1}. [${item.itemCode}] ${item.name} — ${item.unit==='sqm' ? `${item.sqm} kv.m` : `${item.qty} dona`}`
  ).join('\n')

  const text =
`🚚 *YANGI TOPSHIRIQ — YETKAZIB BERISH*

📋 ID: \`${task.taskId || task._id}\`
━━━━━━━━━━━━━━━━━━
👤 *Mijoz:* ${task.customer}
📞 *Tel:* ${task.phone}
📍 *Manzil:* ${task.address}
━━━━━━━━━━━━━━━━━━
📦 *Yetkazib berish kerak:*
${itemsList || '  (Batafsil keyinroq)'}
━━━━━━━━━━━━━━━━━━
💰 *To\'lov:* ${fc(task.totalPrice)}
${task.paid ? '✅ To\'langan' : `⚠️ Yig\'ib olish kerak: ${fc(task.amountDue)}`}${mapBtn}

*Qabul qilasizmi?*`

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Qabul qildim', callback_data: `delivery_accept:${task.taskId || task._id}` },
      { text: '❌ Qabul qila olmayman', callback_data: `delivery_reject:${task.taskId || task._id}` },
    ]]
  }

  try {
    await b.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard })
    return true
  } catch (e) {
    console.error('TG sendDelivery error:', e.message)
    return false
  }
}

// ======================================================
//   ISHCHI — MAHSULOT BIRIKTIRISH XABARI
// ======================================================
async function sendItemToWorker(chatId, item) {
  const b = getBot()
  if (!b || !chatId) return false

  const stageLabel = {
    yuvish: '🫧 Yuvish', quritish: '💨 Quritish', bezak: '✨ Bezak'
  }[item.stage] || item.stage

  const sizeInfo = item.unit === 'sqm'
    ? `📐 O'lchami: ${item.width}m × ${item.length}m = *${item.sqm} kv.m*`
    : `📦 Miqdori: *${item.qty} dona*`

  const text =
`${stageLabel} — *YANGI TOPSHIRIQ*

📋 Buyurtma: \`${item.orderNumber}\`
🏷️ Mahsulot ID: \`${item.itemCode}\`
━━━━━━━━━━━━━━━━━━
🧺 *${item.name}*
${sizeInfo}
━━━━━━━━━━━━━━━━━━

*Bajaring va tugagach xabar bering!*`

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Bajardim!', callback_data: `item_done:${item._id}` },
    ]]
  }

  try {
    await b.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard })
    return true
  } catch (e) {
    console.error('TG sendItem error:', e.message)
    return false
  }
}

// ======================================================
//   MIJOZ — BUYURTMA HOLATI XABARI
// ======================================================
async function sendStatusToCustomer(chatId, info) {
  const b = getBot()
  if (!b || !chatId) return false

  const text =
`🏭 *CleanPro Kimyoviy Tozalash*

✅ Hurmatli ${info.customerName}!

Buyurtmangiz ${info.orderNumber} holati yangilandi:
*${info.statusLabel}*

📞 Savollar: +998901234567`

  try {
    await b.sendMessage(chatId, text, { parse_mode: 'Markdown' })
    return true
  } catch (e) {
    console.error('TG sendStatus error:', e.message)
    return false
  }
}

// ======================================================
//   ODDIY XABAR (istalgan chatId ga)
// ======================================================
async function sendMessage(chatId, text, keyboard = null) {
  const b = getBot()
  if (!b || !chatId) return false
  try {
    const opts = { parse_mode: 'Markdown' }
    if (keyboard) opts.reply_markup = keyboard
    await b.sendMessage(chatId, text, opts)
    return true
  } catch (e) {
    console.error('TG sendMessage error:', e.message)
    return false
  }
}

module.exports = {
  sendPickupToDriver,
  sendDeliveryToDriver,
  sendItemToWorker,
  sendStatusToCustomer,
  sendMessage,
  mapLink,
}
