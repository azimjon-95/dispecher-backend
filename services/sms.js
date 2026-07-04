'use strict'
/**
 * services/sms.js
 * Markaziy SMS yuborish servisi.
 * Settings dan (yoki .env dan) provider olinadi:
 *   SMS_PROVIDER = eskiz | playmobile | twilio | none
 *   SMS_ENABLED  = true | false
 *
 * Ishlatish:
 *   const { sendSMS } = require('./sms')
 *   await sendSMS('+998901234567', 'Xabar matni')
 */
const { Settings } = require('../models')

let _cfg    = null
let _cfgTtl = 0

async function getConfig() {
  if (_cfg && Date.now() < _cfgTtl) return _cfg
  const keys = ['SMS_PROVIDER','SMS_ENABLED','ESKIZ_EMAIL','ESKIZ_PASSWORD','ESKIZ_FROM',
    'PLAYMOBILE_LOGIN','PLAYMOBILE_PASSWORD','PLAYMOBILE_ORIGINATOR',
    'TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_FROM']
  const rows = await Settings.find({ key: { $in: keys } }).lean().catch(() => [])
  const cfg  = {}
  keys.forEach(k => {
    const row = rows.find(r => r.key === k)
    cfg[k] = row?.value || process.env[k] || ''
  })
  if (!cfg.SMS_PROVIDER) cfg.SMS_PROVIDER = process.env.SMS_PROVIDER || 'none'
  if (!cfg.SMS_ENABLED)  cfg.SMS_ENABLED  = process.env.SMS_ENABLED  || 'false'
  _cfg    = cfg
  _cfgTtl = Date.now() + 60_000 // 1 daqiqa cache
  return cfg
}

/**
 * SMS yuborish
 * @param {string} phone  — +998XXXXXXXXX formatida
 * @param {string} text   — xabar matni (maks 160 belgi)
 * @returns {Promise<{ok:boolean, provider?:string, error?:string}>}
 */
async function sendSMS(phone, text) {
  try {
    const cfg = await getConfig()

    if (cfg.SMS_ENABLED !== 'true') {
      console.log(`SMS (o'chirilgan) → ${phone}: ${text}`)
      return { ok: false, error: 'SMS o\'chirilgan' }
    }
    if (cfg.SMS_PROVIDER === 'none') {
      console.log(`SMS (provider yo'q) → ${phone}: ${text}`)
      return { ok: false, error: 'SMS provider tanlanmagan' }
    }

    const cleanPhone = phone.replace(/\D/g, '')

    if (cfg.SMS_PROVIDER === 'eskiz') {
      return await sendEskiz(cfg, cleanPhone, text)
    }
    if (cfg.SMS_PROVIDER === 'playmobile') {
      return await sendPlaymobile(cfg, cleanPhone, text)
    }
    if (cfg.SMS_PROVIDER === 'twilio') {
      return await sendTwilio(cfg, phone, text)
    }

    return { ok: false, error: `Noma'lum provider: ${cfg.SMS_PROVIDER}` }
  } catch (e) {
    console.error('sendSMS xato:', e.message)
    return { ok: false, error: e.message }
  }
}

async function sendEskiz(cfg, phone, text) {
  // Token olish
  const auth = await fetch('https://notify.eskiz.uz/api/auth/login', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email: cfg.ESKIZ_EMAIL, password: cfg.ESKIZ_PASSWORD }),
  }).then(r => r.json())

  if (!auth?.data?.token) throw new Error('Eskiz auth xato: ' + JSON.stringify(auth))

  const res = await fetch('https://notify.eskiz.uz/api/message/sms/send', {
    method:  'POST',
    headers: { 'Authorization': 'Bearer ' + auth.data.token, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ mobile_phone: phone, message: text, from: cfg.ESKIZ_FROM || '4546' }),
  }).then(r => r.json())

  const ok = res?.status === 'waiting' || res?.id
  console.log(`SMS Eskiz → ${phone}: ${ok ? '✅' : '❌'} ${JSON.stringify(res)}`)
  return { ok: !!ok, provider: 'eskiz', result: res }
}

async function sendPlaymobile(cfg, phone, text) {
  const body = {
    messages: [{
      recipient:    phone.startsWith('998') ? phone : '998' + phone.replace(/^0/, ''),
      'message-id': 'gps_' + Date.now(),
      sms: { originator: cfg.PLAYMOBILE_ORIGINATOR || 'Tartib', content: { text } },
    }],
  }
  const res = await fetch('https://send.smsxabar.uz/broker-api/send', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': 'Basic ' + Buffer.from(`${cfg.PLAYMOBILE_LOGIN}:${cfg.PLAYMOBILE_PASSWORD}`).toString('base64'),
    },
    body: JSON.stringify(body),
  }).then(r => r.json())

  const ok = res?.status === 0 || res?.result?.[0]?.status === 0
  console.log(`SMS Playmobile → ${phone}: ${ok ? '✅' : '❌'} ${JSON.stringify(res)}`)
  return { ok: !!ok, provider: 'playmobile', result: res }
}

async function sendTwilio(cfg, phone, text) {
  const params = new URLSearchParams({ To: phone, From: cfg.TWILIO_FROM, Body: text })
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${cfg.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method:  'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${cfg.TWILIO_ACCOUNT_SID}:${cfg.TWILIO_AUTH_TOKEN}`).toString('base64'),
      },
      body: params,
    }
  ).then(r => r.json())

  const ok = res?.sid
  console.log(`SMS Twilio → ${phone}: ${ok ? '✅' : '❌'}`)
  return { ok: !!ok, provider: 'twilio', result: res }
}

module.exports = { sendSMS }
