const { Schema, model } = require('mongoose')

const ETAPLAR    = ['qabul','yuvish','quritish','bezak','yetkazish','tugallandi']
const ITEM_TYPES = ['gilam','kurpa','adyol','yostiq','parda','kiyim','boshqa']

/* ── OrderItem: buyurtma ichidagi har bir mahsulot ── */
const OrderItemSchema = new Schema({
  orderId:      { type: Schema.Types.ObjectId, ref: 'Order', required: true },
  orderNumber:  String,
  name:         { type: String, required: true },
  itemType:     { type: String, enum: ITEM_TYPES, default: 'boshqa' },
  unit:         { type: String, enum: ['sqm','dona'], default: 'dona' },
  width:        Number,
  length:       Number,
  sqm:          Number,
  qty:          { type: Number, default: 1 },
  pricePerUnit: { type: Number, default: 0 },
  totalPrice:   { type: Number, default: 0 },
  stage:        { type: String, enum: ETAPLAR, default: 'qabul' },
  assignments: [{
    stage:       String,
    workerId:    { type: Schema.Types.ObjectId, ref: 'Employee' },
    workerName:  String,
    workerPhone: String,
    assignedAt:  { type: Date, default: Date.now },
    doneAt:      Date,
  }],
  tgNotified:   { type: Boolean, default: false },
  description:  String,
  deletedAt:    Date,
}, { timestamps: true })

/* ── Order ── */
const OrderSchema = new Schema({
  number:      { type: String },
  customer:    { type: String, required: true },
  phone:       { type: String, required: true },
  address:     String,
  lat:         Number,
  lon:         Number,
  description: String,
  itemCount:   { type: Number, default: 0 },
  itemSummary: { type: String, default: '' },
  total:       { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['yangi','qabul_qilindi','yuvishda','qurishda','bezakda','yetkazishda','tugallandi','bekor'],
    default: 'yangi'
  },
  driver:      String,
  note:        String,
  deletedAt:   Date,
}, { timestamps: true })

/* ── Task (delivery / pickup) ── */
const TaskSchema = new Schema({
  order:      String,
  orderId:    { type: Schema.Types.ObjectId, ref: 'Order' },
  customer:   String,
  phone:      String,
  address:    String,
  lat:        Number,
  lon:        Number,
  driver:     String,
  driverId:   { type: Schema.Types.ObjectId, ref: 'Driver' },
  type:       { type: String, enum: ['delivery','pickup'], default: 'delivery' },
  status:     { type: String, enum: ['yangi','jarayonda','yetkazildi','bekor'], default: 'yangi' },
  time:       String,
  date:       String,
  // Payment
  totalPrice: { type: Number, default: 0 },
  amountDue:  { type: Number, default: 0 },
  amountPaid: { type: Number, default: 0 },
  payMethod:  { type: String, enum: ['naqt','karta','transfer','qarz',''], default: '' },
  paid:       { type: Boolean, default: false },
  // Driver earn
  driverEarn: { type: Number, default: 0 },
  // Auto-created
  auto:       { type: Boolean, default: false },
  deletedAt:  Date,
}, { timestamps: true })

/* ── Employee ── */
const EmployeeSchema = new Schema({
  name:      { type: String, required: true },
  phone:     { type: String, required: true },
  tgChatId:  String,
  role:      { type: String, enum: ['Super Admin','Dispecher','Ishchi','Shafyor','Buxgalter','Menejer'], default: 'Ishchi' },
  section:   { type: String, enum: ['yuvish','quritish','bezak','hammasi'], default: 'hammasi' },
  pin:       String,
  salary:    { type: Number, default: 0 },
  balance:   { type: Number, default: 0 },
  status:    { type: String, enum: ['active','inactive'], default: 'active' },
  joinDate:  String,
  deletedAt: Date,
}, { timestamps: true })

/* ── Driver ── */
const DriverSchema = new Schema({
  name:          { type: String, required: true },
  phone:         { type: String, required: true },
  pin:           { type: String, index: true },
  tgChatId:      String,
  car:           String,
  plate:         String,
  status:        { type: String, enum: ['faol','band','dam'], default: 'faol' },
  // Ish holati — botdan boshqariladi
  isWorking:     { type: Boolean, default: false },   // ish boshladi/tugatdi
  workStartedAt: Date,                                 // ish boshlagan vaqt
  // WebApp GPS kuzatuv holati
  webappOpenedAt:  Date,   // oxirgi marta webapp ochilgan vaqt
  webappClosedAt:  Date,   // webapp yopilgan vaqt
  gpsReminderAt:   Date,   // oxirgi bot eslatma yuborilgan vaqt   // oxirgi GPS eslatma SMS yuborilgan vaqt
  trips:         { type: Number, default: 0 },
  balance:       { type: Number, default: 0 },
  deletedAt:     Date,
}, { timestamps: true })

/* ── Customer ── */
const CustomerSchema = new Schema({
  name:       { type: String, required: true },
  phone:      { type: String, required: true, unique: true },
  address:    String,
  discount:   { type: Number, default: 0 },
  totalSpent: { type: Number, default: 0 },
  orders:     { type: Number, default: 0 },
  status:     { type: String, enum: ['active','inactive'], default: 'active' },
  // Geo location — bir marta olinsa qayta so'ralmasin
  lat:        Number,
  lon:        Number,
  locationSaved: { type: Boolean, default: false },
  // Buyurtmalar tarixi
  orderHistory: [{
    orderId:  { type: Schema.Types.ObjectId, ref: 'Order' },
    number:   String,
    total:    Number,
    status:   String,
    date:     String,
  }],
  // Oxirgi buyurtma sanasi
  lastOrderDate: Date,
  note: String,
  deletedAt:  Date,
}, { timestamps: true })

/* ── Finance ── */
const FinanceSchema = new Schema({
  type:        { type: String, enum: ['kirim','chiqim'], required: true },
  description: { type: String, required: true },
  amount:      { type: Number, required: true },
  category:    { type: String, default: 'Boshqa' },
  orderId:     { type: Schema.Types.ObjectId, ref: 'Order' },
  by:          String,
  date:        String,
  deletedAt:   Date,
}, { timestamps: true })

/* ── Salary ── */
const SalarySchema = new Schema({
  employee:   String,
  employeeId: { type: Schema.Types.ObjectId, ref: 'Employee' },
  role:       String,
  month:      String,
  items:      { type: Number, default: 0 },
  sqm:        { type: Number, default: 0 },
  base:       { type: Number, default: 0 },
  bonus:      { type: Number, default: 0 },
  fine:       { type: Number, default: 0 },
  earned:     { type: Number, default: 0 },
  total:      { type: Number, default: 0 },
  paid:       { type: Boolean, default: false },
  paidAt:     Date,
}, { timestamps: true })

/* ── Price list ── */
const PriceSchema = new Schema({
  name:     { type: String, required: true },
  itemType: { type: String, enum: ITEM_TYPES },
  unit:     { type: String, enum: ['sqm','dona'], default: 'dona' },
  price:    { type: Number, required: true },
  active:   { type: Boolean, default: true },
}, { timestamps: true })

/* ── Settings ── */
const SettingsSchema = new Schema({
  key:   { type: String, unique: true, required: true },
  value: Schema.Types.Mixed,
}, { timestamps: true })

/* ── AuditLog ── */

/* ── Attendance (Davomat) ── */
const AttendanceSchema = new Schema({
  employeeId:  { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  employeeName:String,
  date:        { type: String, required: true },  // YYYY-MM-DD
  checkIn:     String,   // HH:mm
  checkOut:    String,
  status:      { type: String, enum: ['keldi','kelmadi','yarim'], default:'keldi' },
  tgChatId:    String,
  note:        String,
}, { timestamps: true })

/* ── SalaryPayment (Avans/Oylik/Jarima) ── */
const SalaryPaymentSchema = new Schema({
  employeeId:   { type: Schema.Types.ObjectId, ref: 'Employee' },
  employeeName: String,
  type:         { type: String, enum: ['avans','oylik','jarima','bonus'], default:'oylik' },
  amount:       { type: Number, required: true },
  note:         String,
  date:         { type: String, default: () => new Date().toISOString().slice(0,10) },
  paidBy:       String,
}, { timestamps: true })

/* ── HomeService (Uyga borib xizmat) ── */
const HomeServiceSchema = new Schema({
  number:       String,
  customer:     String,
  phone:        String,
  address:      String,
  lat:          Number,
  lon:          Number,
  scheduledDate:String,
  scheduledTime:String,
  workers:      [{ workerId: Schema.Types.ObjectId, workerName: String, percent: Number }],
  workerPercent:{ type: Number, default: 10 },  // % per worker total
  status:       { type: String, enum: ['rejalashtirilgan','jarayonda','bajarildi','bekor'], default:'rejalashtirilgan' },
  description:  String,
  totalAmount:  { type: Number, default: 0 },
  paidAmount:   { type: Number, default: 0 },
  deletedAt:    Date,
}, { timestamps: true })
const AuditLogSchema = new Schema({
  action:   String,
  resource: String,
  data:     Schema.Types.Mixed,
  by:       String,
}, { timestamps: true })

/* ── Counter ── (atomic auto-increment uchun, masalan buyurtma raqami)
   countDocuments() o'rniga ishlatiladi — chunki ikkita so'rov bir
   vaqtda kelganda countDocuments() bir xil raqamni qaytarib,
   dublikat buyurtma raqamiga olib kelishi mumkin edi. */
const CounterSchema = new Schema({
  key:   { type: String, unique: true, required: true },
  value: { type: Number, default: 1000 },
})

module.exports = {
  Order:     model('Order',     OrderSchema),
  OrderItem: model('OrderItem', OrderItemSchema),
  Task:      model('Task',      TaskSchema),
  Employee:  model('Employee',  EmployeeSchema),
  Driver:    model('Driver',    DriverSchema),
  Customer:  model('Customer',  CustomerSchema),
  Finance:   model('Finance',   FinanceSchema),
  Salary:    model('Salary',    SalarySchema),
  Price:     model('Price',     PriceSchema),
  Settings:    model('Settings',    SettingsSchema),
  Attendance:  model('Attendance',  AttendanceSchema),
  SalaryPayment: model('SalaryPayment', SalaryPaymentSchema),
  HomeService: model('HomeService', HomeServiceSchema),
  AuditLog:  model('AuditLog',  AuditLogSchema),
  Counter:   model('Counter',   CounterSchema),
}
