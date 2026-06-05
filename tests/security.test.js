'use strict'
const { validate } = require('../middleware/security')
let passed=0,failed=0
function test(name,fn){try{fn();console.log(`  ✅ ${name}`);passed++}catch(e){console.log(`  ❌ ${name}: ${e.message}`);failed++}}
function assert(v,m){if(!v)throw new Error(m||'Assertion failed')}
function assertFalse(v,m){if(v)throw new Error(m||'Should be false')}

console.log('\n🔒 XAVFSIZLIK TESTLARI\n')

console.log('📋 1. Phone Validation:')
test("To'g'ri format",    ()=>assert(validate.phone('+998901234567')))
test("9 raqam",           ()=>assert(validate.phone('901234567')))
test("Noto'g'ri format",  ()=>assertFalse(validate.phone('abc')))
test("Bo'sh string",      ()=>assertFalse(validate.phone('')))

console.log('\n💉 2. NoSQL Injection:')
test("Normal matn",       ()=>assert(validate.safeString('Azimjon')))
test("$gt operator",      ()=>assertFalse(validate.safeString('$gt')))
test("$where injection",  ()=>assertFalse(validate.safeString('$where: 1==1')))
test("Uzun matn (>500)",  ()=>assertFalse(validate.safeString('a'.repeat(501))))

console.log('\n🕷️  3. XSS:')
test("Normal matn",       ()=>assert(validate.safeString('Oddiy matn 123')))
test("<script> teg",      ()=>assertFalse(validate.safeString('<script>alert(1)</script>')))
test("javascript:",       ()=>assertFalse(validate.safeString('javascript:void(0)')))

console.log('\n🧹 4. Object Sanitization:')
test("Normal object",     ()=>{ const r=validate.cleanObject({name:'Test',amount:1000}); assert(r.name==='Test') })
test("$ key o'chiriladi", ()=>{ const r=validate.cleanObject({'$gt':0,name:'Test'}); assert(r['$gt']===undefined) })
test("Dot notation",      ()=>{ const r=validate.cleanObject({'a.b':'x'}); assert(r['a.b']===undefined) })
test("Nested injection",  ()=>{ const r=validate.cleanObject({f:{'$ne':null}}); assert(r.f['$ne']===undefined) })

console.log('\n💰 5. Amount:')
test("Musbat son",        ()=>assert(validate.amount(1000)))
test("Nol",               ()=>assert(validate.amount(0)))
test("Manfiy son",        ()=>assertFalse(validate.amount(-1)))
test("Juda katta",        ()=>assertFalse(validate.amount(1_000_000_001)))
test("String",            ()=>assertFalse(validate.amount('abc')))

console.log('\n🔑 6. ObjectId:')
test("To'g'ri ObjectId",  ()=>assert(validate.objectId('507f1f77bcf86cd799439011')))
test("Qisqa string",      ()=>assertFalse(validate.objectId('abc')))
test("Injection urinish", ()=>assertFalse(validate.objectId('{$ne:null}')))

console.log(`\n${'─'.repeat(40)}`)
console.log(`✅ ${passed} ta o'tdi  |  ❌ ${failed} ta muvaffaqiyatsiz  |  Jami: ${passed+failed}`)
if(failed===0)console.log('\n🎉 Barcha xavfsizlik testlari muvaffaqiyatli!\n')
else{console.log('\n⚠️  Muammo bor!\n');process.exit(1)}
