const express    = require('express');
const router     = express.Router();
const bcrypt     = require('bcryptjs');
const multer     = require('multer');
const XLSX       = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { User, AttendanceRecord, Notification, AuditLog } = require('../models/database');
const { authenticate, authorize } = require('../middleware/auth');
const { slugify } = require('../utils/folderLabel');
const { sendMail } = require('../utils/mailer');
const path            = require('path');
const { uploadFile }  = require('../utils/storage');

const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const validate = (req, res, next) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(422).json({ success: false, message: errs.array()[0].msg, errors: errs.array() });
  next();
};

const uploadProfilePhoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only images allowed'));
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return cb(new Error('Only JPG, PNG or WEBP'));
    cb(null, true);
  },
});
 
// ── GET /api/users ────────────────────────────────────────────────────────
router.get('/', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    let users;
    if (['admin', 'hr', 'super_admin'].includes(req.user.role)) {
      users = await User.aggregate([
        { $lookup: { from: 'users', localField: 'manager_id', foreignField: '_id', as: 'manager' } },
        { $lookup: { from: 'users', localField: 'hr_id',      foreignField: '_id', as: 'hr'      } },
        { $addFields: {
    manager_name: { $arrayElemAt: ['$manager.name', 0] },
    hr_name:      { $arrayElemAt: ['$hr.name',      0] },
}},
        
        { $project: { manager: 0, password_hash: 0 } },
        { $sort: { role: 1, name: 1 } },
      ]);
    } else {
      users = await User
        .find({ manager_id: req.user.id })
        .select('-password_hash')
        .sort({ name: 1 })
        .lean();
    }
    res.json({ success: true, data: users.map(formatUser) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/users/managers ───────────────────────────────────────────────
router.get('/managers', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    const managers = await User
      .find({ role: 'manager', is_active: 1 })
      .select('emp_id name email department')
      .lean();
    res.json({ success: true, data: managers });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/users/locations ──────────────────────────────────────────────
router.get('/locations', authenticate, async (req, res) => {
  try {
    const [blocks, districts] = await Promise.all([
      User.distinct('assigned_block',    { assigned_block:    { $ne: null, $exists: true } }),
      User.distinct('assigned_district', { assigned_district: { $ne: null, $exists: true } }),
    ]);
    const locations = [...new Set([...blocks.filter(Boolean), ...districts.filter(Boolean)])].sort();
    res.json({ success: true, data: locations });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/users/employees ──────────────────────────────────────────────
router.get('/employees', authenticate, authorize('manager', 'admin', 'hr', 'super_admin'), async (req, res) => {
  try {
    let filter = { role: 'employee', is_active: 1 };
    if (req.query.manager_id) {
      filter.manager_id = req.query.manager_id;
    } else if (req.user.role === 'manager') {
      filter.manager_id = req.user.id;
    }
    const employees = await User
      .find(filter)
      .select('emp_id name email department assigned_block manager_id')
      .sort({ name: 1 })
      .lean();
    res.json({ success: true, data: employees });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/users/team/attendance-summary ────────────────────────────────
// Must be BEFORE /:id to avoid Express route shadowing
router.get('/team/attendance-summary', authenticate, authorize('manager', 'admin'), async (req, res) => {
  try {
    const today      = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const matchStage = req.user.role === 'manager'
      ? { manager_id: req.user.id }
      : { role: 'employee' };

    const summary = await User.aggregate([
      { $match: matchStage },
      {
        $lookup: {
          from:     'attendancerecords',
          let:      { empId: '$_id' },
          pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$emp_id', '$$empId'] }, { $eq: ['$date', today] }] } } }],
          as: 'todayRecord',
        },
      },
      {
        $addFields: {
          today_status:  { $arrayElemAt: ['$todayRecord.status',       0] },
          today_duty:    { $arrayElemAt: ['$todayRecord.duty_type',    0] },
          checkin_time:  { $arrayElemAt: ['$todayRecord.checkin_time', 0] },
          checkout_time: { $arrayElemAt: ['$todayRecord.checkout_time',0] },
        },
      },
      { $project: { password_hash: 0, todayRecord: 0 } },
      { $sort: { name: 1 } },
    ]);

    res.json({ success: true, data: summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/users/bulk-upload/template ──────────────────────────────────
// Must be BEFORE /:id
router.get('/bulk-upload/template', authenticate, authorize('super_admin', 'admin'), (req, res) => {
  const wb = XLSX.utils.book_new();
  const templateData = [
    ['name', 'email', 'empId', 'password', 'role', 'roleType', 'designation', 'department', 'managerId', 'phone', 'assignedBlock', 'assignedDistrict'],
    ['Manager One',  'manager1@brp.com', 'MGR001', 'R@m%Brp@26', 'manager',  'BRP', '', 'Engineering',    '',       '9876500001', 'Agartala', 'West Tripura'],
    ['HR One',       'hr1@brp.com',      'HR001',  'R@m%Brp@26', 'hr',       'URP', '', 'HR',             '',       '9876500010', 'Agartala', 'West Tripura'],
    ['Admin One',    'admin1@brp.com',   'ADM001', 'R@m%Brp@26', 'admin',    '',    '', 'Administration', '',       '9876500020', 'Agartala', 'West Tripura'],
    ['Rajesh Kumar', 'rajesh@brp.com',   'EMP001', 'R@m%Brp@26', 'employee', 'BRP', '', 'Engineering',    'MGR001', '9876543210', 'Agartala', 'West Tripura'],
  ];
  const ws = XLSX.utils.aoa_to_sheet(templateData);
  ws['!cols'] = [{ wch:16 },{ wch:22 },{ wch:10 },{ wch:12 },{ wch:12 },{ wch:10 },{ wch:14 },{ wch:16 },{ wch:14 },{ wch:13 },{ wch:14 },{ wch:16 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Users Template');
  const rules = XLSX.utils.aoa_to_sheet([
    ['Column','Required','Notes'],
    ['name','YES','Full name'],['email','YES','Valid unique email'],
    ['empId','YES','Unique employee ID'],['password','YES*','Min 6 chars. Required for new users only.'],
    ['role','YES','employee, manager, admin, hr, super_admin'],
    ['roleType','NO','BRP or URP (for employees)'],
    ['designation','NO','Job title'],
    ['department','YES','Department name'],
    ['managerId','NO','Manager emp_id OR full name'],['phone','NO','10-digit mobile'],
    ['assignedBlock','NO','Block name'],['assignedDistrict','NO','District name'],
    ['','',''],['NOTE','','Add manager rows ABOVE employee rows'],
  ]);
  rules['!cols'] = [{ wch:18 },{ wch:10 },{ wch:65 }];
  XLSX.utils.book_append_sheet(wb, rules, 'Rules');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="bulk_upload_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── GET /api/users/:id ────────────────────────────────────────────────────
// Includes scan_papers array — used by ReportsPage to show employee scans
router.get('/:id', authenticate, async (req, res) => {
  try {
    // Employees can only fetch their own profile
    if (req.user.role === 'employee' && req.params.id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    const user = await User.findById(req.params.id)
      .select('-password_hash -email_verify_token -pwd_reset_token -phone_otp -login_attempts -login_locked_until')
      .lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, data: formatUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/users ───────────────────────────────────────────────────────
router.post('/', authenticate, authorize('admin'), [
  body('name').notEmpty().withMessage('Name is required'),
  body('email').isEmail().withMessage('Valid email is required').normalizeEmail({ gmail_remove_dots: false, gmail_remove_subaddress: false, all_lowercase: true }),
  body('empId').notEmpty().withMessage('Employee ID is required'),
  body('role').isIn(['employee', 'manager', 'admin', 'hr', 'super_admin']).withMessage('Invalid role'),
  body('department').notEmpty().withMessage('Department is required'),
], validate, async (req, res) => {
  try {
    const { name, email, empId, role, department, managerId, hrId,phone, assignedBlock, assignedDistrict, roleType, designation } = req.body;
    
    if (req.user.role === 'admin' && ['admin', 'super_admin'].includes(role))
      return res.status(403).json({ success: false, message: 'Admins cannot create admin or super admin accounts' });
    
    const existingEmail = await User.findOne({ email }).lean();
    if (existingEmail) return res.status(409).json({ success: false, message: 'Email already exists' });
    
    const existingEmpId = await User.findOne({ emp_id: empId }).lean();
    if (existingEmpId) return res.status(409).json({ success: false, message: 'Employee ID already exists' });
    
    const crypto    = require('crypto');
    const genToken  = () => crypto.randomBytes(32).toString('hex');
    const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
    const rawVerifyToken  = genToken(); 
    const hashedVerifyTok = hashToken(rawVerifyToken);
    const rawResetToken   = genToken(); 
    const hashedResetTok  = hashToken(rawResetToken);
    const tempPassword    = `Tmp@${crypto.randomBytes(8).toString('hex')}`;
    const id = uuidv4();
    
    // ── FIX 1A: Include roleType and designation ──
    await User.create({
      _id: id, 
      emp_id: empId, 
      name, 
      email,
      password_hash: bcrypt.hashSync(tempPassword, 12), 
      role, 
      department,
      manager_id: managerId || null, 
      hr_id: hrId || null,
      phone: phone || null,
      assigned_block: assignedBlock || null, 
      assigned_district: assignedDistrict || null,
      role_type: roleType || null,        // ← FIX: Save roleType
      designation: designation || null,    // ← FIX: Save designation
      email_verified: false,
      email_verify_token: hashedVerifyTok, 
      email_verify_expires: new Date(Date.now() + 86400000),
      pwd_reset_token: hashedResetTok, 
      pwd_reset_expires: new Date(Date.now() + 86400000),
    });
    
    // Send welcome email with app's own reset link (same SMTP that powers forgot-password)
    const { sendMail } = require('../utils/mailer');
    const FRONTEND  = process.env.FRONTEND_URL || 'https://ams-frontend-web-q2lw.onrender.com';
    const resetUrl  = `${FRONTEND}/reset-password?token=${rawResetToken}`;

    sendMail(
      email,
      '[BRP AMS] Your Account is Ready — Set Your Password',
      `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f2f6f8;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f6f8;padding:40px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0"
  style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08);">
<tr><td style="background:#0b1e3b;padding:28px 32px;">
  <h1 style="margin:0;color:#fff;font-size:22px;font-weight:800;">BRP · AMS</h1>
  <p style="margin:4px 0 0;color:rgba(255,255,255,.6);font-size:13px;">Attendance Management System</p>
</td></tr>
<tr><td style="padding:32px;">
  <h2 style="margin:0 0 16px;color:#0b1e3b;font-size:18px;">Welcome, ${name}! Set Your Password</h2>
  <p style="color:#475569;font-size:14px;line-height:1.6;">
    Your BRP AMS account has been created. Click the button below to set your password and activate your account.
  </p>
  <p style="color:#475569;font-size:14px;line-height:1.6;">
    <strong>Employee ID:</strong> ${empId}<br/>
    <strong>Role:</strong> ${role}
  </p>
  <div style="text-align:center;margin:28px 0;">
    <a href="${resetUrl}"
      style="background:#21879d;color:#fff;padding:14px 32px;border-radius:8px;
             text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">
      Set My Password
    </a>
  </div>
  <p style="color:#94a3b8;font-size:12px;word-break:break-all;">
    Or copy this link: ${resetUrl}
  </p>
  <p style="color:#dc2626;font-size:13px;">
    This link expires in <strong>24 hours</strong>. If you did not expect this email, contact your administrator.
  </p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0;">
  <p style="margin:0;color:#94a3b8;font-size:12px;">Do not reply to this email · BRP AMS Automated System</p>
</td></tr>
</table>
</td></tr></table></body></html>`
    ).catch(err => console.error('[User Create] Welcome email failed:', err.message));

    const user = await User.findById(id).select('-password_hash -email_verify_token -pwd_reset_token -phone_otp -login_attempts -login_locked_until').lean();
    res.status(201).json({ success: true, message: 'User created. Password setup email sent to ' + email, data: formatUser(user) });
  } catch (err) { 
    console.error(err); 
    res.status(500).json({ success: false, message: 'Server error' }); 
  }
});

// ── PUT /api/users/:id/reset-password — must be before PUT /:id ──────────
router.put('/:id/reset-password', authenticate, authorize('admin'), async (req, res) => {
  try {
    const target = await User.findById(req.params.id).select('-password_hash -email_verify_token -pwd_reset_token -phone_otp -login_attempts -login_locked_until').lean();
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });
    if (String(req.params.id) === String(req.user.id))
      return res.status(400).json({ success: false, message: 'Use profile settings to change your own password' });
    if (req.user.role === 'admin' && ['admin', 'super_admin'].includes(target.role))
      return res.status(403).json({ success: false, message: 'Admins cannot reset passwords for admin or super admin accounts' });
    
    const crypto = require('crypto');
    const rawResetToken  = crypto.randomBytes(32).toString('hex');
    const hashedResetTok = crypto.createHash('sha256').update(rawResetToken).digest('hex');
    const tempPassword   = `Tmp@${crypto.randomBytes(8).toString('hex')}`;
    
    await User.findByIdAndUpdate(req.params.id, { $set: { password_hash: bcrypt.hashSync(tempPassword, 12), pwd_reset_token: hashedResetTok, pwd_reset_expires: new Date(Date.now() + 30 * 60 * 1000) } });
    
    const FRONTEND = process.env.FRONTEND_URL || 'https://ams-frontend-web-q2lw.onrender.com';
    const resetUrl = `${FRONTEND}/reset-password?token=${rawResetToken}`;
    
    await sendMail(target.email, '[BRP AMS] Password Reset — Set Your New Password',
      `<p>Hi ${target.name}, your password was reset by an admin. <a href="${resetUrl}">Set new password</a> (expires in 30 minutes).</p>`);
    
    try { 
      await Notification.create({ 
        _id: uuidv4(), 
        user_id: target._id, 
        title: 'Password Reset by Admin', 
        message: 'Check your email for the reset link (expires in 5 minutes).', 
        type: 'warning', 
        is_read: 0 
      }); 
    } catch (_) {}
    
    res.json({ success: true, message: `Password reset email sent to ${target.name} (${target.email})` });
  } catch (err) { 
    console.error(err); 
    res.status(500).json({ success: false, message: 'Server error: ' + err.message }); 
  }
});

// ── PUT /api/users/:id ────────────────────────────────────────────────────
router.put('/:id', authenticate, authorize('admin', 'super_admin'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password_hash -email_verify_token -pwd_reset_token -phone_otp -login_attempts -login_locked_until').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    
    if (req.user.role === 'admin' && ['admin', 'super_admin'].includes(user.role))
      return res.status(403).json({ success: false, message: 'Admins cannot modify admin or super admin accounts' });
    
    const { name, email, role, department, managerId, hrId,phone, isActive, assignedBlock, assignedDistrict, roleType, designation } = req.body;
    
    if (req.user.role === 'admin' && role && ['admin', 'super_admin'].includes(role))
      return res.status(403).json({ success: false, message: 'Admins cannot assign admin or super admin roles' });
    
    const newManagerId = managerId !== undefined ? (managerId || null) : user.manager_id;
    const newBlock     = assignedBlock !== undefined ? (assignedBlock || null) : user.assigned_block;
    const newDistrict  = assignedDistrict !== undefined ? (assignedDistrict || null) : user.assigned_district;
    const newIsActive  = isActive !== undefined ? isActive : user.is_active;
    
    // ── FIX 1B: Include roleType and designation in update ──
    const update = { 
      name: name || user.name, 
      email: email || user.email, 
      role: role || user.role, 
      department: department || user.department, 
      manager_id: newManagerId, 
      hr_id: hrId !== undefined ? (hrId || null) : (user.hr_id || null),
      phone: phone !== undefined ? (phone || null) : user.phone, 
      is_active: newIsActive, 
      assigned_block: newBlock, 
      assigned_district: newDistrict,
     role_type: (roleType !== undefined && roleType !== null) ? roleType : user.role_type,        // ← FIX
      designation: designation !== undefined ? (designation || null) : user.designation  // ← FIX
    };
    
    await User.findByIdAndUpdate(req.params.id, { $set: update });
    
    const targetRole = role || user.role;
    if (targetRole === 'employee') {
      const changes = [];
      if (newManagerId !== user.manager_id) {
        if (newManagerId) {
          const mgr = await User.findById(newManagerId).select('name').lean();
          if (mgr) { 
            changes.push(`Reporting Manager assigned: ${mgr.name}`); 
            await Notification.create({ 
              _id: uuidv4(), 
              user_id: newManagerId, 
              title: 'New Team Member Assigned', 
              message: `${user.name} (${user.emp_id}) has been assigned to your team by admin.`, 
              type: 'info', 
              is_read: 0, 
              link: '/manager/team' 
            }); 
          }
        } else { 
          changes.push('Reporting Manager removed'); 
        }
        if (user.manager_id && user.manager_id !== newManagerId) {
          await Notification.create({ 
            _id: uuidv4(), 
            user_id: user.manager_id, 
            title: 'Team Member Reassigned', 
            message: `${user.name} (${user.emp_id}) has been reassigned by admin.`, 
            type: 'warning', 
            is_read: 0, 
            link: '/manager/team' 
          });
        }
      }
      if (newBlock !== user.assigned_block) changes.push(`Block: ${newBlock || 'removed'}`);
      if (newDistrict !== user.assigned_district) changes.push(`District: ${newDistrict || 'removed'}`);
      if (newIsActive !== user.is_active) changes.push(newIsActive ? 'Account activated' : 'Account deactivated');
      if (changes.length) {
        await Notification.create({ 
          _id: uuidv4(), 
          user_id: user._id, 
          title: 'Your Profile Has Been Updated', 
          message: `Admin has updated your profile — ${changes.join(', ')}.`, 
          type: 'info', 
          is_read: 0, 
          link: '/profile' 
        });
      }
    }
    
    const updated = await User.findById(req.params.id).select('-password_hash -email_verify_token -pwd_reset_token -phone_otp -login_attempts -login_locked_until').lean();
    res.json({ success: true, message: 'User updated', data: formatUser(updated) });
  } catch (err) { 
    console.error(err); 
    res.status(500).json({ success: false, message: 'Server error' }); 
  }
});

// ── DELETE /api/users/:id ─────────────────────────────────────────────────
router.delete('/:id', authenticate, authorize('admin', 'super_admin'), async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ success: false, message: 'Cannot delete yourself' });
    if (req.user.role === 'admin') {
      const target = await User.findById(req.params.id).select('role').lean();
      if (target && ['admin', 'super_admin'].includes(target.role))
        return res.status(403).json({ success: false, message: 'Admins cannot delete admin or super admin accounts' });
    }
    const deleted = await User.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, message: 'User deleted successfully' });
  } catch (err) { 
    console.error(err); 
    res.status(500).json({ success: false, message: 'Server error' }); 
  }
});

// ── POST /api/users/request-assignment ───────────────────────────────────
router.post('/request-assignment', authenticate, authorize('employee'), [
  body('type').isIn(['manager', 'block']).withMessage('type must be "manager" or "block"'),
  body('note').optional().trim(),
], validate, async (req, res) => {
  try {
    const { type, note } = req.body;
    const emp    = await User.findById(req.user.id).select('name emp_id email').lean();
    const admins = await User.find({ role: 'admin', is_active: 1 }).select('_id email').lean();
    const label   = type === 'manager' ? 'Manager Assignment' : 'Block Assignment';
    const title   = `Request: ${label}`;
    const message = note ? `${emp.name} (${emp.emp_id}) requests a ${type === 'manager' ? 'reporting manager' : 'block'} assignment. Note: ${note}` : `${emp.name} (${emp.emp_id}) requests a ${type === 'manager' ? 'reporting manager' : 'block'} assignment.`;
    
    if (admins.length) {
      await Notification.insertMany(admins.map(a => ({ 
        _id: uuidv4(), 
        user_id: a._id, 
        title, 
        message, 
        type: 'warning', 
        is_read: 0, 
        link: `/admin/users?editUser=${req.user.id}` 
      })));
    }
    
    for (const admin of admins) {
      sendMail(admin.email, `[BRP AMS] ${title} — ${emp.name}`, `<p>${message}</p><p>Log in to Admin → Users to assign.</p>`);
    }
    
    res.json({ success: true, message: `Request sent to admin${admins.length > 1 ? 's' : ''}.` });
  } catch (err) { 
    console.error(err); 
    res.status(500).json({ success: false, message: 'Server error' }); 
  }
});

// ── POST /api/users/request-location-change ───────────────────────────────
router.post('/request-location-change', authenticate, authorize('employee'), [
  body('note').optional().trim(),
], validate, async (req, res) => {
  try {
    const { note } = req.body;
    const emp    = await User.findById(req.user.id).select('name emp_id email assigned_block assigned_district').lean();
    const admins = await User.find({ role: 'admin', is_active: 1 }).select('_id email').lean();
    const current = [emp.assigned_block, emp.assigned_district].filter(Boolean).join(' / ') || 'Not assigned';
    const title   = 'Request: Location / Block Change';
    const message = note ? `${emp.name} (${emp.emp_id}) requests a location change (current: ${current}). Note: ${note}` : `${emp.name} (${emp.emp_id}) requests a location change (current: ${current}).`;
    
    if (admins.length) {
      await Notification.insertMany(admins.map(a => ({ 
        _id: uuidv4(), 
        user_id: a._id, 
        title, 
        message, 
        type: 'warning', 
        is_read: 0, 
        link: `/admin/users?editUser=${req.user.id}` 
      })));
    }
    
    for (const admin of admins) {
      sendMail(admin.email, `[BRP AMS] ${title} — ${emp.name}`, `<p>${message}</p>`);
    }
    
    res.json({ success: true, message: 'Location change request sent to admin.' });
  } catch (err) { 
    console.error(err); 
    res.status(500).json({ success: false, message: 'Server error' }); 
  }
});

// ── POST /api/users/bulk-upload ───────────────────────────────────────────
router.post('/bulk-upload', authenticate, authorize('super_admin', 'admin'), uploadMem.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'Excel file required' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    if (!rows.length) return res.status(400).json({ success: false, message: 'Empty spreadsheet' });
    
    const VALID_ROLES = ['employee', 'manager', 'admin', 'hr', 'super_admin'];
    const results = { created: 0, updated: 0, skipped: 0, errors: [] };
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]; 
      const rowNum = i + 2;
      const empId = String(row['EmpId'] || row['empId'] || '').trim();
      const name  = String(row['Name']  || row['name']  || '').trim();
      const email = String(row['Email'] || row['email'] || '').trim().toLowerCase();
      const password = String(row['Password'] || row['password'] || '').trim();
      const role  = String(row['Role']  || row['role']  || 'employee').trim().toLowerCase();
      const dept  = String(row['Department'] || row['department'] || '').trim();
      const phone = String(row['Phone'] || row['phone'] || '').trim() || null;
      const block    = String(row['assignedBlock']    || row['Block']    || row['block']    || '').trim() || null;
const district = String(row['assignedDistrict'] || row['District'] || row['district'] || '').trim() || null;
      const roleType = String(row['RoleType'] || row['roleType'] || '').trim() || null;  // ← FIX: Support roleType
      const designation = String(row['Designation'] || row['designation'] || '').trim() || null;  // ← FIX: Support designation
      const managerRef = String(row['managerId'] || row['ManagerId'] || row['Manager Name'] || row['manager_name'] || row['ManagerName'] || row['manager_id'] || '').trim() || null;
      
      if (!empId || !name || !email || !dept) { 
        results.errors.push({ row: rowNum, reason: 'Missing required field' }); 
        results.skipped++; 
        continue; 
      }
      if (!VALID_ROLES.includes(role)) { 
        results.errors.push({ row: rowNum, reason: `Invalid role: ${role}` }); 
        results.skipped++; 
        continue; 
      }
      
      let managerId = null;
      if (managerRef) {
        const mgr = await User.findOne({ $or: [{ emp_id: managerRef }, { name: { $regex: new RegExp(`^${managerRef}$`, 'i') } }], is_active: 1 }).lean();
        if (mgr) { 
          managerId = mgr._id; 
        } else { 
          results.errors.push({ row: rowNum, reason: `Manager "${managerRef}" not found — created without manager` }); 
        }
      }
      
      const existing = await User.findOne({ $or: [{ emp_id: empId }, { email }] }).lean();
      if (existing) {
        const update = { 
          name, 
          email, 
          role, 
          department: dept, 
          phone, 
          manager_id: managerId || existing.manager_id || null, 
          assigned_block: block, 
          assigned_district: district,
          role_type: roleType,           // ← FIX: Support update
          designation: designation        // ← FIX: Support update
        };
        if (password && password.length >= 6) update.password_hash = bcrypt.hashSync(password, 10);
        await User.findByIdAndUpdate(existing._id, { $set: update });
        results.updated++;
      } else {
        if (!password || password.length < 6) { 
          results.errors.push({ row: rowNum, reason: `Password required for "${empId}"` }); 
          results.skipped++; 
          continue; 
        }
        await User.create({ 
          _id: uuidv4(), 
          emp_id: empId, 
          name, 
          email, 
          password_hash: bcrypt.hashSync(password, 10), 
          role, 
          department: dept, 
          manager_id: managerId || null, 
          phone, 
          assigned_block: block, 
          assigned_district: district,
          role_type: roleType,           // ← FIX: Support creation
          designation: designation,       // ← FIX: Support creation
          is_active: 1, 
          email_verified: true, 
          phone_verified: true 
        });
        results.created++;
      }
    }
    
    res.json({ success: true, message: `Bulk upload complete — ${results.created} created, ${results.updated} updated, ${results.skipped} skipped`, data: results });
  } catch (err) { 
    console.error('Bulk upload error:', err); 
    res.status(500).json({ success: false, message: 'Server error: ' + err.message }); 
  }
});

// ── POST /api/users/profile-photo ─────────────────────────────────────────
router.post(
  '/profile-photo',
  authenticate,
  authorize('employee', 'manager', 'admin', 'hr', 'super_admin'),
  uploadProfilePhoto.single('photo'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No photo provided' });
      }
 
      const user = await User.findById(req.user.id).select('profile_photo_path profile_photo_uploaded role name emp_id').lean();
 
      // ── FIX 2A: Check if user role is allowed ────────────────────────────
      if (!['employee'].includes(user?.role)) {
        return res.status(403).json({
          success: false,
          message: 'Profile photo enrollment is only available for employees.',
          locked: true,
        });
      }

      // ── LOCKED: reject if already uploaded ────────────────────────────
      if (user?.profile_photo_path) {
        return res.status(409).json({
          success: false,
          message:  'Profile photo already enrolled. It cannot be changed. Contact your admin if there is an issue.',
          locked:   true,
          uploadedAt: user.profile_photo_uploaded,
        });
      }
 
      const profileFolderLabel = `${slugify(user?.name)}(${user?.emp_id || req.user.emp_id || req.user.id})`;
      const photoPath = await uploadFile(
        req.file.buffer,
        `ams/employees/${profileFolderLabel}/profile-photos`,
        req.file.originalname,
        req.file.mimetype,
      );
 
      await User.findByIdAndUpdate(req.user.id, {
        $set: {
          profile_photo_path:     photoPath,
          profile_photo_uploaded: new Date(),
          face_enrolled:          true,   // mark face as enrolled for attendance gating
        },
      }, { strict: false });
 
      await AuditLog.create({
        _id: uuidv4(), user_id: req.user.id,
        action: 'PROFILE_PHOTO_UPLOAD',
        entity_type: 'user', entity_id: req.user.id,
        new_value: 'Profile photo enrolled (one-time)',
      });
 
      res.status(201).json({
        success:    true,
        message:    'Profile photo enrolled successfully. This is permanent and cannot be changed.',
        photoPath,
      });
    } catch (err) {
      console.error('[ProfilePhoto]', err);
      res.status(500).json({ success: false, message: err.message || 'Server error' });
    }
  },
);
 
// ── (Optional) Admin-only force-reset for fraud/re-enrollment ────────────
// DELETE /api/users/:id/profile-photo   (admin / super_admin only)
router.delete(
  '/:id/profile-photo',
  authenticate,
  authorize('admin', 'super_admin'),
  async (req, res) => {
    try {
      await User.findByIdAndUpdate(req.params.id, {
        $set: { profile_photo_path: null, profile_photo_uploaded: null, face_enrolled: false },
      }, { strict: false });
 
      await AuditLog.create({
        _id: uuidv4(), user_id: req.user.id,
        action: 'PROFILE_PHOTO_RESET',
        entity_type: 'user', entity_id: req.params.id,
        new_value: 'Profile photo reset by admin',
      });
 
      res.json({ success: true, message: 'Profile photo reset. Employee may now re-enroll.' });
    } catch (err) {
      console.error('[ProfilePhotoReset]', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  },
);

// ── Format helper ─────────────────────────────────────────────────────────
function formatUser(u) {
  // ── Normalize scan_papers to grouped-by-month array format ───────────
  // Each month entry: { month, monthLabel, files: [{ path, fileName, fileIndex, uploadedAt }] }
  const rawPapers = Array.isArray(u.scan_papers) ? u.scan_papers : [];
  const papersByMonth = {};
  rawPapers.forEach(s => {
    if (!s.month || !s.path) return;
    if (!papersByMonth[s.month]) {
      papersByMonth[s.month] = {
        month:      s.month,
        monthLabel: s.month_label || s.month,
        files:      [],
      };
    }
    papersByMonth[s.month].files.push({
      path:       s.path,
      fileName:   s.file_name   || `Scan_${s.month}_${s.file_index ?? papersByMonth[s.month].files.length + 1}`,
      fileIndex:  s.file_index  ?? papersByMonth[s.month].files.length,
      uploadedAt: s.uploaded_at || null,
    });
  });
  // Sort files within each month by fileIndex
  Object.values(papersByMonth).forEach(m => {
    m.files.sort((a, b) => a.fileIndex - b.fileIndex);
  });
  
  return {
    id:               u._id || u.id,
    empId:            u.emp_id,
    name:             u.name,
    email:            u.email,
    role:             u.role,
    roleType:         u.role_type || null,      // ← FIX: Include roleType
    designation:      u.designation || null,     // ← FIX: Include designation
    department:       u.department,
    managerId:        u.manager_id,
    hrId:             u.hr_id     || null,
    hrName:           u.hr_name    || null,   // ← ADD
    managerName:      u.manager_name || null,
    phone:            u.phone,
    isActive:         !!u.is_active,
    createdAt:        u.created_at,
    assignedBlock:    u.assigned_block,
    assignedDistrict: u.assigned_district,
    // ── New grouped scan papers ─────────────────────────────────────
    // Shape: { "2026-04": { month, monthLabel, files: [...] }, ... }
    scan_papers:         papersByMonth,
    // ── Raw array also returned for server-side processing ──────────
    scan_papers_raw:     rawPapers,
    // ── Legacy fields ───────────────────────────────────────────────
    scan_paper_path:     u.scan_paper_path     || null,
    scan_paper_uploaded: u.scan_paper_uploaded || null,
    face_enrolled:       u.face_enrolled          || false,
    faceEnrolled:        u.face_enrolled          || false,
    facePhotoUrl:        u.profile_photo_path     || null,
    profile_photo_uploaded: u.profile_photo_uploaded || null,
  };
}

module.exports = router;