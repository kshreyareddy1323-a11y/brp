const express    = require('express');
const router     = express.Router();
const multer     = require('multer');
const cloudinary = require('cloudinary').v2;
const { authenticate: protect } = require('../middleware/auth');
const { MonthlyReport } =require('../models/database');
const { employeeFolderLabel } = require('../utils/folderLabel');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// Helper — upload buffer to Cloudinary
const uploadToCloudinary = (buffer, options) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
    stream.end(buffer);
  });

// ── GET /api/monthly-report — current user's last 3 months ──────────────
router.get('/', protect, async (req, res) => {
  try {
    const reports = await MonthlyReport.find({ user_id: req.user.id })
      .sort({ month_key: -1 })
      .limit(3);
    res.json({ success: true, data: reports });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/monthly-report/upload ─────────────────────────────────────
router.post('/upload', protect, upload.single('file'), async (req, res) => {
  try {
    const { month_key } = req.body;
    if (!month_key) return res.status(400).json({ success: false, message: 'month_key required' });
    if (!req.file)  return res.status(400).json({ success: false, message: 'No file uploaded' });

    // One upload per month per user
    const existing = await MonthlyReport.findOne({ user_id: req.user.id, month_key });
    if (existing) return res.status(409).json({ success: false, message: 'Already uploaded for this month' });

    // Upload to Cloudinary
const isImage = req.file.mimetype.startsWith('image/');
const isPdf   = req.file.mimetype === 'application/pdf';
const monthlyFolderLabel = await employeeFolderLabel(req.user.id, { emp_id: req.user.emp_id });
const result  = await uploadToCloudinary(req.file.buffer, {
  folder:          `ams/employees/${monthlyFolderLabel}/monthly_reports`,
  resource_type:   (isImage || isPdf) ? 'image' : 'raw',  // PDFs upload as 'image' → served inline
  public_id:       `${req.user.id}_${month_key}`,
  use_filename:    true,
  unique_filename: false,
});

    // expires_at = start of month + 3 months
    const [year, month] = month_key.split('-').map(Number);
    const expiresAt = new Date(year, month - 1 + 3, 1); // +3 months from upload month
const fileUrl = result.secure_url;

const report = await MonthlyReport.create({
  user_id:     req.user.id,
  month_key,
  file_name:   req.file.originalname,
  file_type:   req.file.mimetype,
  file_url:    fileUrl,
  public_id:   result.public_id,
  uploaded_at: new Date(),
  expires_at:  expiresAt,
});

    res.json({ success: true, data: report });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /api/monthly-report/all ──────────────────────────────────────
router.delete('/all', protect, async (req, res) => {
  try {
    const reports = await MonthlyReport.find({ user_id: req.user.id });
    await Promise.all(reports.map(r =>
      r.public_id
        ? cloudinary.uploader.destroy(r.public_id, { resource_type: r.file_type?.startsWith('image/') ? 'image' : 'raw' })
        : Promise.resolve()
    ));
    await MonthlyReport.deleteMany({ user_id: req.user.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /api/monthly-report/:id ──────────────────────────────────────
router.delete('/:id', protect, async (req, res) => {
  try {
    const report = await MonthlyReport.findOne({ _id: req.params.id, user_id: req.user.id });
    if (!report) return res.status(404).json({ success: false, message: 'Not found' });
    if (report.public_id) {
      await cloudinary.uploader.destroy(report.public_id, {
        resource_type: report.file_type?.startsWith('image/') ? 'image' : 'raw',
      });
    }
    await report.deleteOne();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;