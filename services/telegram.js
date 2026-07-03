// ═══════════════════════════════════════════════
//  TELEGRAM NOTIFICATION SERVICE
//  bot instance BU YERDA YARATILMAYDI!
//  bot/index.js dan olinadi — bitta instance kafolati.
//  Bu fayl faqat xabar yuborish funksiyalarini eksport qiladi.
// ═══════════════════════════════════════════════

// bot/index.js ga murojaat qilganda bot allaqachon ishga tushgan bo'ladi
// (server.js botni alohida import qilmaydi, routes/bot.js orqali keladi)
function getBot() {
  return require('../bot/index').bot
}

const fc = n => (n||0).toLocaleString('ru-RU') + " so'm"

function mapLink(lat, lon, address) {
  if (lat && lon) return `https://yandex.com/maps/?ll=${lon},${lat}&z=16&pt=${lon},${lat},pm2rdm`
  if (address)    return `https://yandex.com/maps/?text=${encodeURIComponent(address)}`
  return null
}

async function sendPickupToDriver(chatId, task) {
  const b = getBot()
  if (!b || !chatId) return false
  const mapBtn   = (task.lat && task.lon) || task.address ? `\n\n🗺️ Xarita:\n${mapLink(task.lat, task.lon, task.address)}` : ''
  const itemsList = (task.items||[]).map((it,i) => `  ${i+1}. ${it.name} — ${it.unit==='sqm' ? `${it.sqm} kv.m` : `${it.qty} dona`}`).join('\n')
  const text =
`🚗 *YANGI TOPSHIRIQ — OLIB KELISH*

📋 ID: \`${task.taskId||task._id}\`
━━━━━━━━━━━━━━━━━━
👤 *Mijoz:* ${task.customer}
📞 *Tel:* ${task.phone}
📍 *Manzil:* ${task.address}
━━━━━━━━━━━━━━━━━━
📦 *Olib kelish kerak:*
${itemsList||(task.description||'  (Batafsil keyinroq)')}
━━━━━━━━━━━━━━━━━━${mapBtn}

*Qabul qilasizmi?*`
  try {
    await b.sendMessage(chatId, text, {
      parse_mode:'Markdown',
      reply_markup:{ inline_keyboard:[[
        { text:'✅ Qabul qildim',        callback_data:`pickup_accept:${task.taskId||task._id}` },
        { text:'❌ Qabul qila olmayman', callback_data:`pickup_reject:${task.taskId||task._id}` },
      ]] }
    })
    return true
  } catch(e) { console.error('sendPickup:', e.message); return false }
}

async function sendDeliveryToDriver(chatId, task) {
  const b = getBot()
  if (!b || !chatId) return false
  const mapBtn    = (task.lat && task.lon) || task.address ? `\n🗺️ Xarita:\n${mapLink(task.lat, task.lon, task.address)}` : ''
  const itemsList = (task.items||[]).map((it,i) => `  ${i+1}. ${it.name} — ${it.unit==='sqm' ? `${it.sqm} kv.m` : `${it.qty} dona`}`).join('\n')
  const text =
`🚚 *YANGI TOPSHIRIQ — YETKAZIB BERISH*

📋 ID: \`${task.taskId||task._id}\`
━━━━━━━━━━━━━━━━━━
👤 *Mijoz:* ${task.customer}
📞 *Tel:* ${task.phone}
📍 *Manzil:* ${task.address}
━━━━━━━━━━━━━━━━━━
📦 *Yetkazib berish:*
${itemsList||'  (Batafsil keyinroq)'}
━━━━━━━━━━━━━━━━━━
💰 *To'lov:* ${fc(task.totalPrice)}
${task.paid ? "✅ To'langan" : `⚠️ Yig'ib olish: ${fc(task.amountDue)}`}${mapBtn}

*Qabul qilasizmi?*`
  try {
    await b.sendMessage(chatId, text, {
      parse_mode:'Markdown',
      reply_markup:{ inline_keyboard:[[
        { text:'✅ Qabul qildim',        callback_data:`delivery_accept:${task.taskId||task._id}` },
        { text:'❌ Qabul qila olmayman', callback_data:`delivery_reject:${task.taskId||task._id}` },
      ]] }
    })
    return true
  } catch(e) { console.error('sendDelivery:', e.message); return false }
}

async function sendItemToWorker(chatId, item) {
  const b = getBot()
  if (!b || !chatId) return false
  const stageLabel = { yuvish:'🫧 Yuvish', quritish:'💨 Quritish', bezak:'✨ Bezak' }[item.stage]||item.stage
  const sizeInfo   = item.unit==='sqm' ? `📐 O'lchami: ${item.width}m × ${item.length}m = *${item.sqm} kv.m*` : `📦 Miqdori: *${item.qty} dona*`
  const text =
`${stageLabel} — *YANGI TOPSHIRIQ*

📋 Buyurtma: \`${item.orderNumber}\`
━━━━━━━━━━━━━━━━━━
🧺 *${item.name}*
${sizeInfo}
━━━━━━━━━━━━━━━━━━

*Bajaring va tugagach xabar bering!*`
  try {
    await b.sendMessage(chatId, text, {
      parse_mode:'Markdown',
      reply_markup:{ inline_keyboard:[[{ text:'✅ Bajardim!', callback_data:`worker_done:${item._id}` }]] }
    })
    return true
  } catch(e) { console.error('sendItem:', e.message); return false }
}

async function sendMessage(chatId, text, keyboard=null) {
  const b = getBot()
  if (!b || !chatId) return false
  try {
    await b.sendMessage(chatId, text, { parse_mode:'Markdown', ...(keyboard ? { reply_markup:keyboard } : {}) })
    return true
  } catch(e) { console.error('sendMessage:', e.message); return false }
}

module.exports = { sendPickupToDriver, sendDeliveryToDriver, sendItemToWorker, sendMessage, mapLink }
