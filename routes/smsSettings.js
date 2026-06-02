const router  = require('express').Router()
const { Settings } = require('../models')
const cache   = require('../redis/cache')
const CACHE_K = 'settings:sms'
const ALL_SMS_KEYS = ['SMS_PROVIDER','SMS_ENABLED','TG_SMS_ENABLED','PHONE_SMS_ENABLED','ESKIZ_EMAIL','ESKIZ_PASSWORD','ESKIZ_FROM','PLAYMOBILE_LOGIN','PLAYMOBILE_PASSWORD','PLAYMOBILE_ORIGINATOR','TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_FROM']

async function getSettings() {
  const cached = await cache.get(CACHE_K)
  if (cached) return cached
  const rows = await Settings.find({ key: { $in: ALL_SMS_KEYS } }).lean()
  const result = {}
  ALL_SMS_KEYS.forEach(k => { const row = rows.find(r=>r.key===k); result[k] = row?.value ?? process.env[k] ?? '' })
  if (!result.SMS_PROVIDER)      result.SMS_PROVIDER      = 'none'
  if (!result.SMS_ENABLED)       result.SMS_ENABLED       = 'false'
  if (!result.TG_SMS_ENABLED)    result.TG_SMS_ENABLED    = 'true'
  if (!result.PHONE_SMS_ENABLED) result.PHONE_SMS_ENABLED = 'true'
  await cache.set(CACHE_K, result, 120)
  return result
}

router.get('/', async (req, res) => {
  try { res.json(await getSettings()) }
  catch(e) { res.status(500).json({ error: e.message }) }
})

router.put('/', async (req, res) => {
  try {
    const body = req.body || {}
    for (const key of ALL_SMS_KEYS) {
      if (body[key] !== undefined) {
        await Settings.findOneAndUpdate({ key }, { $set: { key, value: body[key] } }, { upsert: true })
        process.env[key] = String(body[key])
      }
    }
    await cache.del(CACHE_K)
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

router.post('/test', async (req, res) => {
  try {
    const { phone } = req.body
    if (!phone) return res.status(400).json({ error: 'Telefon raqam kiriting' })
    const cfg = await getSettings()
    if (cfg.SMS_PROVIDER === 'none' || cfg.SMS_ENABLED !== 'true')
      return res.status(400).json({ error: "SMS provaydera tanlanmagan yoki o'chirilgan" })
    let result = null
    if (cfg.SMS_PROVIDER === 'eskiz') {
      const auth = await fetch('https://notify.eskiz.uz/api/auth/login',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ email:cfg.ESKIZ_EMAIL, password:cfg.ESKIZ_PASSWORD }) }).then(r=>r.json())
      if (!auth?.data?.token) throw new Error('Eskiz auth xato')
      result = await fetch('https://notify.eskiz.uz/api/message/sms/send',{ method:'POST', headers:{'Authorization':'Bearer '+auth.data.token,'Content-Type':'application/json'}, body:JSON.stringify({ mobile_phone:phone.replace(/\D/g,''), message:'Dispecher test SMS', from:cfg.ESKIZ_FROM||'4546' }) }).then(r=>r.json())
    }
    else if (cfg.SMS_PROVIDER === 'playmobile') {
      const body = { messages:[{ recipient:phone.replace(/\+/g,''), 'message-id':'test_'+Date.now(), sms:{ originator:cfg.PLAYMOBILE_ORIGINATOR||'Dispecher', content:{ text:'Dispecher test SMS' } } }] }
      result = await fetch('https://send.smsxabar.uz/broker-api/send',{ method:'POST', headers:{'Content-Type':'application/json','Authorization':'Basic '+Buffer.from(`${cfg.PLAYMOBILE_LOGIN}:${cfg.PLAYMOBILE_PASSWORD}`).toString('base64')}, body:JSON.stringify(body) }).then(r=>r.json())
    }
    else if (cfg.SMS_PROVIDER === 'twilio') {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.TWILIO_ACCOUNT_SID}/Messages.json`
      const params = new URLSearchParams({ To:phone, From:cfg.TWILIO_FROM, Body:'Dispecher test SMS' })
      result = await fetch(url,{ method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded','Authorization':'Basic '+Buffer.from(`${cfg.TWILIO_ACCOUNT_SID}:${cfg.TWILIO_AUTH_TOKEN}`).toString('base64')}, body:params }).then(r=>r.json())
    }
    res.json({ ok:true, provider:cfg.SMS_PROVIDER, result })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

module.exports = router
