const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('FATAL: MONGO_URI environment variable is required');
  process.exit(1);
}
// ── Schemas ───────────────────────────────────────────────────────────────

const userSchema = new mongoose.Schema({
  _id:               { type: String },
  emp_id:            { type: String, unique: true, required: true },
  name:              { type: String, required: true },
  email:             { type: String, unique: true, required: true },
  password_hash:     { type: String, required: true },
  role:              { type: String, enum: ['employee', 'manager', 'admin', 'hr', 'super_admin'], required: true },
  department:        { type: String, required: true },
  manager_id:        { type: String, ref: 'User', default: null },
  phone:             { type: String, default: null },
  is_active:         { type: Number, default: 1 },
  assigned_block:    { type: String, default: null },
  assigned_district: { type: String, default: null },
  // ── Email verification ───────────────────────────────────────────────
  email_verified:       { type: Boolean, default: false },
  email_verify_token:   { type: String,  default: null },  // hashed token
  email_verify_expires: { type: Date,    default: null },
  // ── Password reset ───────────────────────────────────────────────────
  pwd_reset_token:      { type: String,  default: null },  // hashed token
  pwd_reset_expires:    { type: Date,    default: null },
  // ── Password reset OTP ───────────────────────────────────────────────
  pwd_reset_otp:        { type: String,  default: null },  // hashed OTP
  pwd_reset_otp_expires:{ type: Date,    default: null },
  // ── Password changed timestamp (for global logout) ─────────────────
  pwd_changed_at:       { type: Date,    default: null },
  // ── Phone OTP ────────────────────────────────────────────────────────
  phone_otp:            { type: String,  default: null },  // hashed OTP
  phone_otp_expires:    { type: Date,    default: null },
  phone_verified:       { type: Boolean, default: false },
  // ── Account lockout ─────────────────────────────────────────────────
  failed_login_attempts: { type: Number, default: 0 },
  login_locked_until:    { type: Date, default: null },
// ── Profile Photo (uploaded once, locked) ─────────────────────────────────
profile_photo_path:     { type: String, default: null },   // Cloudinary URL
profile_photo_uploaded: { type: Date,   default: null },   // when it was uploaded
  // Legacy single-scan fields kept for backwards compat
  scan_paper_path:     { type: String, default: null },
  scan_paper_uploaded: { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

userSchema.index({ manager_id: 1 });
userSchema.index({ role: 1 });
userSchema.index({ is_active: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// ATTENDANCE RECORD
// selfie_path          → Cloudinary URL (checkin photo)
// checkout_selfie_path → Cloudinary URL (checkout photo)
// reapply_docs         → Array of Cloudinary URLs
// ─────────────────────────────────────────────────────────────────────────────
const attendanceRecordSchema = new mongoose.Schema({
  _id:                  { type: String },
  emp_id:               { type: String, ref: 'User', required: true },
  date:                 { type: String, required: true },
  end_date:             { type: String, default: null },
  duty_type:            { type: String, enum: ['Office Duty', 'On Duty', 'Leave'], required: true },
  sector:               { type: String, default: null },
  description:          { type: String, default: null },
  status:               { type: String, enum: ['Draft', 'Pending', 'Approved', 'Rejected'], default: 'Draft' },
  // ── Cloudinary URLs ──────────────────────────────────────────────────────
  selfie_path:          { type: String, default: null }, // Cloudinary secure URL
  checkout_selfie_path: { type: String, default: null }, // Cloudinary secure URL
  // ────────────────────────────────────────────────────────────────────────
  latitude:             { type: Number, default: null },
  longitude:            { type: Number, default: null },
  location_address:     { type: String, default: null },
  checkin_time:         { type: String, default: null },
  checkout_time:        { type: String, default: null },
  checkin_lat:          { type: Number, default: null },
  checkin_lng:          { type: Number, default: null },
  checkout_lat:         { type: Number, default: null },
  checkout_lng:         { type: Number, default: null },
  manager_id:           { type: String, ref: 'User', default: null },
  manager_remark:       { type: String, default: null },
  admin_remark:         { type: String, default: null },
  actioned_by:          { type: String, ref: 'User', default: null },
  actioned_at:          { type: Date, default: null },
  submitted_at:         { type: Date, default: null },
  worked_hours:         { type: Number, default: null },
  is_auto_checkout:     { type: Boolean, default: false },
  checkout_remarks:     { type: String, default: null },
  leave_type:           { type: String, enum: ['Sick Leave', 'Casual Leave', 'Half Day', 'Emergency Leave', null], default: null },
  leave_reason:         { type: String, default: null },
  leave_status:         { type: String, enum: ['Pending', 'Approved', 'Rejected', null], default: null },
  reapply_reason:       { type: String, default: null },
  reapply_docs:         { type: [String], default: [] }, // Array of Cloudinary URLs
  reapplied_at:         { type: Date, default: null },
  hr_override:          { type: Boolean, default: false },
  hr_remark:            { type: String, default: null },
  hr_actioned_by:       { type: String, ref: 'User', default: null },
  hr_actioned_at:       { type: Date, default: null },
  overridden_by:        { type: String, enum: ['hr', 'super_admin', null], default: null },
override_remark:      { type: String, default: null },
signed_reports: [{
    path:        String,
    name:        String,
    month:       String,   // "YYYY-MM"
    month_label: String,   // "April 2026"
    uploaded_at: Date,
    uploaded_by: String,   // user _id
  }]
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

attendanceRecordSchema.index({ emp_id: 1, date: 1 }, { unique: true });
attendanceRecordSchema.index({ date: 1 });
attendanceRecordSchema.index({ status: 1 });
attendanceRecordSchema.index({ manager_id: 1 });
attendanceRecordSchema.index({ manager_id: 1, status: 1 });
attendanceRecordSchema.index({ date: 1, status: 1 });

// ─────────────────────────────────────────────────────────────────────────────

const notificationSchema = new mongoose.Schema({
  _id:               { type: String },
  user_id:           { type: String, ref: 'User', required: true },
  title:             { type: String, required: true },
  message:           { type: String, required: true },
  type:              { type: String, enum: ['info', 'success', 'warning', 'error'], default: 'info' },
  is_read:           { type: Number, default: 0 },
  related_record_id: { type: String, ref: 'AttendanceRecord', default: null },
  link:              { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

notificationSchema.index({ user_id: 1 });
notificationSchema.index({ user_id: 1, is_read: 1 });

const auditLogSchema = new mongoose.Schema({
  _id:         { type: String },
  user_id:     { type: String, ref: 'User', required: true },
  action:      { type: String, required: true },
  entity_type: { type: String, default: null },
  entity_id:   { type: String, default: null },
  old_value:   { type: String, default: null },
  new_value:   { type: String, default: null },
  ip_address:  { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

auditLogSchema.index({ entity_type: 1, entity_id: 1 });
auditLogSchema.index({ user_id: 1 });
auditLogSchema.index({ created_at: 1 });

const revokedTokenSchema = new mongoose.Schema({
  _id:        { type: String },
  revoked_at: { type: Date, default: Date.now },
});

const activitySchema = new mongoose.Schema({
  _id:              { type: String },
  user_id:          { type: String, ref: 'User', required: true },
  msme_name:        { type: String, required: true },
  udyam_number:     { type: String, required: true },
  sector:           { type: String, enum: ['Manufacturing', 'Services', 'Trade', 'Agriculture', 'Other'], required: true },
  support_type:     { type: String, enum: ['Awareness', 'Marketing Linkage', 'Loan Facilitation', 'Training/Workshop', 'Advisory/Other'], required: true },
  block_name:       { type: String, required: true },
  latitude:         { type: Number, default: null },
  longitude:        { type: Number, default: null },
  location_address: { type: String, default: null },
  activity_date:    { type: String, required: true },
  remarks:          { type: String, default: null },
  resource_type: { type: String }, // 'image' | 'raw'
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

activitySchema.index({ user_id: 1 });
activitySchema.index({ activity_date: 1 });
activitySchema.index({ block_name: 1 });
activitySchema.index({ sector: 1 });
activitySchema.index({ activity_date: 1, block_name: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITY DOCUMENT
// file_path  → Cloudinary secure URL (was: local filename like act_userid_123.jpg)
// public_id  → Cloudinary public_id for deletion (NEW field)
// ─────────────────────────────────────────────────────────────────────────────
const activityDocumentSchema = new mongoose.Schema({
  _id:         { type: String },
  activity_id: { type: String, ref: 'Activity', required: true },
  file_path:   { type: String, required: true }, // Cloudinary secure URL
  file_name:   { type: String, required: true }, // original filename
  file_type:   { type: String, default: null  }, // mimetype
  public_id:   { type: String, default: null  }, // ← NEW: Cloudinary public_id for deletion
  resource_type: { type: String }, // 'image' | 'raw'
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

activityDocumentSchema.index({ activity_id: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITY SCHEDULE
// ─────────────────────────────────────────────────────────────────────────────
const activityScheduleSchema = new mongoose.Schema({
  _id:              { type: String },
  title:            { type: String, required: true },
  description:      { type: String, default: null },
  scheduled_date:   { type: String, required: true },
  location:         { type: String, default: null },
  assigned_to:      { type: String, ref: 'User', default: null },
  manager_id:       { type: String, ref: 'User', default: null },
  created_by:       { type: String, ref: 'User', required: true },
  assigned_by:      { type: String, ref: 'User', default: null }, // who assigned this activity
  assigned_by_name: { type: String, default: null },               // quick-display name
  manager_id:       { type: String, ref: 'User', default: null }, // selected manager
  status:           { type: String, enum: ['Pending', 'Initiated', 'Completed'], default: 'Pending' },
  initiated_by:     { type: String, ref: 'User', default: null },
  initiated_at:     { type: Date, default: null },
  completed_by:     { type: String, ref: 'User', default: null },
  completed_at:     { type: Date, default: null },
  work_description: { type: String, default: null },
  remarks:          { type: String, default: null },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

activityScheduleSchema.index({ scheduled_date: 1 });
activityScheduleSchema.index({ status: 1 });
activityScheduleSchema.index({ assigned_to: 1 });
activityScheduleSchema.index({ created_by: 1 });
activityScheduleSchema.index({ manager_id: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULE DOCUMENT
// file_path  → Cloudinary secure URL (was: schedule/sched_userid_123.jpg)
// public_id  → Cloudinary public_id for deletion (NEW field)
// ─────────────────────────────────────────────────────────────────────────────
const scheduleDocumentSchema = new mongoose.Schema({
  _id:         { type: String },
  schedule_id: { type: String, ref: 'ActivitySchedule', required: true },
  file_path:   { type: String, required: true }, // Cloudinary secure URL
  file_name:   { type: String, required: true }, // original filename
  file_type:   { type: String, default: null  }, // mimetype
  public_id:   { type: String, default: null  }, // ← NEW: Cloudinary public_id for deletion
  resource_type: { type: String }, // 'image' | 'raw'
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

scheduleDocumentSchema.index({ schedule_id: 1 });

// ── Models ────────────────────────────────────────────────────────────────

const User             = mongoose.model('User',             userSchema);
const AttendanceRecord = mongoose.model('AttendanceRecord', attendanceRecordSchema);
const Notification     = mongoose.model('Notification',     notificationSchema);
const AuditLog         = mongoose.model('AuditLog',         auditLogSchema);
const RevokedToken     = mongoose.model('RevokedToken',     revokedTokenSchema);
const Activity         = mongoose.model('Activity',         activitySchema);
const ActivityDocument = mongoose.model('ActivityDocument', activityDocumentSchema);
const ActivitySchedule = mongoose.model('ActivitySchedule', activityScheduleSchema);
const ScheduleDocument = mongoose.model('ScheduleDocument', scheduleDocumentSchema);

// ── Connect ───────────────────────────────────────────────────────────────

const connectionPromise = mongoose.connect(MONGO_URI, {
  maxPoolSize:             100,
  minPoolSize:               5,
  serverSelectionTimeoutMS: 8000,
  socketTimeoutMS:          45000,
  connectTimeoutMS:         10000,
  heartbeatFrequencyMS:     10000,
  retryWrites:               true,
  retryReads:                true,
})
  .then(() => console.log('✅ MongoDB Atlas connected (pool: 5–100)'))
  .catch(err => { console.error('❌ MongoDB connection error:', err); process.exit(1); });

module.exports = {
  User,
  AttendanceRecord,
  Notification,
  AuditLog,
  RevokedToken,
  Activity,
  ActivityDocument,
  ActivitySchedule,
  ScheduleDocument,
  connectionPromise,
};