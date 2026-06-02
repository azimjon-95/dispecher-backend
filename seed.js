/**
 * seed.js — Demo ma'lumotlar bazasini to'ldirish
 * Ishlatish: node seed.js
 */
require('dotenv').config()
const mongoose = require('mongoose')
const {
  Order, Task, WorkerTask,
  Employee, Driver, Customer,
  Finance, Salary
} = require('./models')

const URI = process.env.MONGO_URI || 'mongodb://localhost:27017/dispecher'

async function seed() {
  await mongoose.connect(URI)
  console.log('✅ MongoDB connected')

  // Clean
  await Promise.all([
    Order.deleteMany({}), Task.deleteMany({}), WorkerTask.deleteMany({}),
    Employee.deleteMany({}), Driver.deleteMany({}), Customer.deleteMany({}),
    Finance.deleteMany({}), Salary.deleteMany({}),
  ])
  console.log('🗑️  Old data cleared')

  // Employees
  await Employee.insertMany([
    { name:'Bobur Aliyev',    phone:'+998901234567', role:'Dispecher', pin:'1234', status:'active',   salary:2500000, joinDate:'2024-01-15' },
    { name:'Sardor Mirzayev', phone:'+998911234567', role:'Shafyor',   pin:'5678', status:'active',   salary:3000000, joinDate:'2024-03-20' },
    { name:'Zulfiya Holova',  phone:'+998921234567', role:'Ishchi',    pin:'9012', status:'active',   salary:1800000, joinDate:'2024-06-01' },
    { name:'Komil Tursunov',  phone:'+998931234567', role:'Buxgalter', pin:'3456', status:'inactive', salary:2200000, joinDate:'2023-11-10' },
    { name:'Feruza Nazarova', phone:'+998941234567', role:'Ishchi',    pin:'7890', status:'active',   salary:1800000, joinDate:'2025-01-05' },
  ])

  // Drivers
  await Driver.insertMany([
    { name:'Bobur Aliyev',    phone:'+998901234567', car:'Chevrolet Cobalt',  plate:'01 A 123 BC', status:'faol', trips:142 },
    { name:'Sardor Mirzayev', phone:'+998911234567', car:'Chevrolet Nexia 3', plate:'01 B 456 DE', status:'band', trips:98  },
    { name:'Anvar Qosimov',   phone:'+998921234567', car:'Chevrolet Lacetti', plate:'01 C 789 FG', status:'dam',  trips:201 },
  ])

  // Customers
  await Customer.insertMany([
    { name:'Alisher Karimov', phone:'+998901234567', address:'Chilonzor',     orders:14, totalSpent:1850000, discount:5,  status:'active'   },
    { name:'Malika Tosheva',  phone:'+998901112233', address:'Yunusobod',     orders:3,  totalSpent:245000,  discount:0,  status:'active'   },
    { name:'Jasur Rashidov',  phone:'+998931234567', address:'Mirzo Ulugbek', orders:22, totalSpent:4200000, discount:10, status:'active'   },
    { name:'Nodira Yusupova', phone:'+998941111111', address:'Sergeli',       orders:7,  totalSpent:680000,  discount:0,  status:'inactive' },
  ])

  // Orders
  await Order.insertMany([
    { number:'#1042', customer:'Alisher Karimov',  phone:'+998901234567', address:'Chilonzor 12-uy',   items:3, total:180000, status:'jarayonda', driver:'Bobur A.' },
    { number:'#1043', customer:'Malika Tosheva',   phone:'+998901112233', address:'Yunusobod 5-blok',  items:1, total:45000,  status:'yangi',      driver:'' },
    { number:'#1044', customer:'Jasur Rashidov',   phone:'+998931234567', address:'Mirzo Ulugbek',     items:5, total:320000, status:'tayyor',     driver:'Sardor M.' },
    { number:'#1045', customer:'Nodira Yusupova',  phone:'+998941111111', address:'Sergeli 9-kv.',     items:2, total:95000,  status:'yetkazildi', driver:'Bobur A.' },
    { number:'#1046', customer:'Sherzod Nazarov',  phone:'+998951234567', address:'Uchtepa 3-dom',     items:4, total:215000, status:'bekor',      driver:'' },
    { number:'#1047', customer:'Dilnoza Qodirova', phone:'+998971234567', address:'Yakkasaroy 7',      items:2, total:130000, status:'jarayonda',  driver:'Sardor M.' },
    { number:'#1048', customer:'Kamol Ergashev',   phone:'+998901111222', address:'Bektemir 2',        items:6, total:480000, status:'yangi',      driver:'' },
  ])

  // Delivery + Pickup Tasks (with phone, lat, lon)
  await Task.insertMany([
    { order:'#1042', customer:'Alisher K.', phone:'+998901234567', address:'Chilonzor 12-uy',   lat:41.2964, lon:69.2401, driver:'Bobur A.',  type:'delivery', status:'jarayonda',  time:'10:30', date:'2025-05-04' },
    { order:'#1045', customer:'Nodira Y.',  phone:'+998941111111', address:'Sergeli 9-kv.',      lat:41.2510, lon:69.2098, driver:'Sardor M.', type:'delivery', status:'yetkazildi', time:'14:00', date:'2025-05-03' },
    { order:'#1047', customer:'Dilnoza Q.', phone:'+998971234567', address:'Yakkasaroy 7',       lat:null,    lon:null,    driver:'',          type:'delivery', status:'yangi',      time:'',      date:'2025-05-04' },
    { order:'#1048', customer:'Kamol E.',   phone:'+998901111222', address:'Bektemir 2-dom',     lat:41.3111, lon:69.2680, driver:'',          type:'delivery', status:'yangi',      time:'',      date:'2025-05-05' },
    { order:'#1043', customer:'Malika T.',  phone:'+998901112233', address:'Yunusobod 5-blok',   lat:41.3370, lon:69.3000, driver:'Bobur A.',  type:'pickup',   status:'yangi',      time:'11:00', date:'2025-05-04' },
    { order:'#1046', customer:'Sherzod N.', phone:'+998951234567', address:'Uchtepa 3-dom',      lat:null,    lon:null,    driver:'',          type:'pickup',   status:'jarayonda',  time:'13:30', date:'2025-05-04' },
    { order:'#1049', customer:'Barno X.',   phone:'+998902223344', address:'Olmazor 15',         lat:41.3500, lon:69.2300, driver:'',          type:'pickup',   status:'yangi',      time:'09:00', date:'2025-05-05' },
  ])

  // Worker Tasks
  await WorkerTask.insertMany([
    { order:'#1042', item:"Ko'ylak ×3",  worker:'Zulfiya Holova',  status:'jarayonda', qty:3, sqm:2.4 },
    { order:'#1043', item:"Ko'rpa ×1",   worker:'Feruza Nazarova', status:'tayyor',    qty:1, sqm:4.0 },
    { order:'#1047', item:'Gilam ×2',     worker:'Zulfiya Holova',  status:'yangi',     qty:2, sqm:8.0 },
  ])

  // Finance
  await Finance.insertMany([
    { type:'kirim',  description:"Buyurtma #1044 to'lov",  amount:320000, category:'Buyurtma',  date:'2025-05-03', by:'Tizim'    },
    { type:'chiqim', description:'Benzin xarajati',         amount:85000,  category:'Transport', date:'2025-05-04', by:'Bobur A.' },
    { type:'kirim',  description:"Buyurtma #1045 to'lov",  amount:95000,  category:'Buyurtma',  date:'2025-05-03', by:'Tizim'    },
    { type:'chiqim', description:'Kimyoviy vositalar',       amount:150000, category:'Kimyoviy',  date:'2025-05-02', by:'Komil T.' },
    { type:'chiqim', description:"Elektr to'lovi",           amount:200000, category:'Kommunal',  date:'2025-05-01', by:'Komil T.' },
    { type:'kirim',  description:"Buyurtma #1042 to'lov",  amount:180000, category:'Buyurtma',  date:'2025-05-04', by:'Tizim'    },
  ])

  // Salary
  await Salary.insertMany([
    { employee:'Zulfiya Holova',  role:'Ishchi',    items:84, sqm:420, base:1800000, bonus:150000, fine:0,     total:1950000, month:'2025-05', paid:false },
    { employee:'Feruza Nazarova', role:'Ishchi',    items:71, sqm:355, base:1800000, bonus:0,      fine:50000, total:1750000, month:'2025-05', paid:false },
    { employee:'Bobur Aliyev',    role:'Dispecher', items:0,  sqm:0,   base:2500000, bonus:200000, fine:0,     total:2700000, month:'2025-05', paid:true  },
    { employee:'Komil Tursunov',  role:'Buxgalter', items:0,  sqm:0,   base:2200000, bonus:0,      fine:0,     total:2200000, month:'2025-05', paid:false },
  ])

  console.log('✅ Seed completed!')
  process.exit(0)
}

seed().catch(e => { console.error(e); process.exit(1) })
