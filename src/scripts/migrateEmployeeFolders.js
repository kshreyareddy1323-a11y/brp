/**
 * ONE-TIME MIGRATION
 * Moves existing Cloudinary assets out of flat/old folders into
 * ams/employees/{Name}({emp_id})/<subfolder>/... and updates the matching
 * MongoDB documents so the stored URLs stay valid.
 *
 * Run from the project root (same place you'd run `node server.js`):
 *   node scripts/migrate-to-employee-folders.js
 *
 * Safe to re-run: anything already migrated is skipped.
 * Strongly recommended: take a Mongo + Cloudinary backup/export before running.
 */

require('dotenv').config();
const mongoose   = require('mongoose');
const cloudinary  = require('cloudinary').v2;
const {
  User, AttendanceRecord, ActivityDocument, MonthlyReport,
} = require('../models/database');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const DRY_RUN = process.argv.includes('--dry-run');

/* ── Folder label: "Name(emp_id)", e.g. "Sravya(emp001)" ──────────────── */
function slugify(name) {
  return (name || 'Unknown').trim().replace(/[\/\\?%*:|"<>]/g, '').replace(/\s+/g, '_');
}
function folderLabel(name, empId) {
  return `${slugify(name)}(${empId || 'unknown'})`;
}

/* ── Build an index of every resource living under the OLD prefixes ───────
   so we can look up { public_id, resource_type } from a stored secure_url
   without guessing extensions. ─────────────────────────────────────────── */
const OLD_PREFIXES = [
  'ams/selfies', 'ams/scans', 'ams/signed-reports',
  'ams/reapply-docs', 'ams/profile-photos', 'ams/monthly_reports',
  'ams/users', // old per-employee activity-docs root
];
const RESOURCE_TYPES = ['image', 'raw', 'video'];

async function buildUrlIndex() {
  const index = new Map(); // secure_url -> { public_id, resource_type }
  for (const prefix of OLD_PREFIXES) {
    for (const resource_type of RESOURCE_TYPES) {
      let next_cursor;
      do {
        const resp = await cloudinary.api.resources({
          type: 'upload', prefix, resource_type, max_results: 500, next_cursor,
        });
        for (const r of resp.resources) index.set(r.secure_url, { public_id: r.public_id, resource_type });
        next_cursor = resp.next_cursor;
      } while (next_cursor);
    }
  }
  return index;
}

function newPublicId(oldPublicId, label, subfolder) {
  // keep just the filename portion, drop the old folder prefix entirely
  const base = oldPublicId.split('/').pop();
  return `ams/employees/${label}/${subfolder}/${base}`;
}

async function moveAsset(urlIndex, oldUrl, label, subfolder) {
  if (!oldUrl || typeof oldUrl !== 'string') return oldUrl;
  if (oldUrl.includes('/ams/employees/')) return oldUrl; // already migrated
  const found = urlIndex.get(oldUrl);
  if (!found) {
    console.warn(`  ! could not locate Cloudinary asset for URL: ${oldUrl}`);
    return oldUrl;
  }
  const { public_id, resource_type } = found;
  const to_public_id = newPublicId(public_id, label, subfolder);
  if (DRY_RUN) {
    console.log(`  [dry-run] ${public_id} -> ${to_public_id}`);
    return oldUrl;
  }
  const result = await cloudinary.uploader.rename(public_id, to_public_id, { resource_type, overwrite: false });
  console.log(`  moved -> ${result.secure_url}`);
  return result.secure_url;
}

async function migrateProfilePhotos(urlIndex) {
  console.log('\n== Profile photos ==');
  const users = await User.find({ profile_photo_path: { $exists: true, $ne: null } });
  for (const u of users) {
    const label  = folderLabel(u.name, u.emp_id);
    const newUrl = await moveAsset(urlIndex, u.profile_photo_path, label, 'profile-photos');
    if (newUrl !== u.profile_photo_path && !DRY_RUN) {
      u.profile_photo_path = newUrl;
      await u.save();
    }
  }
}

async function migrateScansAndSignedReports(urlIndex) {
  console.log('\n== Scans & signed reports (stored on User) ==');
  const users = await User.find({
    $or: [{ scan_papers: { $exists: true, $ne: [] } }, { signed_reports: { $exists: true, $ne: [] } }],
  });
  for (const u of users) {
    const label = folderLabel(u.name, u.emp_id);
    let changed = false;
    if (Array.isArray(u.scan_papers)) {
      for (const s of u.scan_papers) {
        const newUrl = await moveAsset(urlIndex, s.path, label, 'scans');
        if (newUrl !== s.path) { s.path = newUrl; changed = true; }
      }
    }
    if (Array.isArray(u.signed_reports)) {
      for (const r of u.signed_reports) {
        const newUrl = await moveAsset(urlIndex, r.path, label, 'signed-reports');
        if (newUrl !== r.path) { r.path = newUrl; changed = true; }
      }
    }
    if (changed && !DRY_RUN) { u.markModified('scan_papers'); u.markModified('signed_reports'); await u.save(); }
  }
}

async function migrateAttendanceSelfiesAndReapplyDocs(urlIndex) {
  console.log('\n== Attendance selfies & reapply docs ==');
  const records = await AttendanceRecord.find({
    $or: [
      { selfie_path: { $exists: true, $ne: null } },
      { checkout_selfie_path: { $exists: true, $ne: null } },
      { reapply_docs: { $exists: true, $ne: [] } },
    ],
  });
  for (const rec of records) {
    const owner = await User.findById(rec.emp_id).select('emp_id name').lean();
    const label = folderLabel(owner?.name, owner?.emp_id || rec.emp_id);
    let changed = false;

    const newSelfie = await moveAsset(urlIndex, rec.selfie_path, label, 'selfies');
    if (newSelfie !== rec.selfie_path) { rec.selfie_path = newSelfie; changed = true; }

    const newCheckoutSelfie = await moveAsset(urlIndex, rec.checkout_selfie_path, label, 'selfies');
    if (newCheckoutSelfie !== rec.checkout_selfie_path) { rec.checkout_selfie_path = newCheckoutSelfie; changed = true; }

    if (Array.isArray(rec.reapply_docs)) {
      for (let i = 0; i < rec.reapply_docs.length; i++) {
        const newUrl = await moveAsset(urlIndex, rec.reapply_docs[i], label, 'reapply-docs');
        if (newUrl !== rec.reapply_docs[i]) { rec.reapply_docs[i] = newUrl; changed = true; }
      }
    }
    if (changed && !DRY_RUN) await rec.save();
  }
}

async function migrateActivityDocs(urlIndex) {
  console.log('\n== Activity documents (ams/users/* -> ams/employees/*) ==');
  const docs = await ActivityDocument.find({ file_path: { $regex: '^https://res.cloudinary.com/.*/ams/users/' } });
  for (const d of docs) {
    // file_path looks like .../ams/users/{emp_id}/activity-docs/...
    const m = d.file_path.match(/\/ams\/users\/([^/]+)\/activity-docs\//);
    const empId = m ? m[1] : 'unknown';
    const owner = await User.findOne({ emp_id: empId }).select('name emp_id').lean();
    const label = folderLabel(owner?.name, owner?.emp_id || empId);
    const newUrl = await moveAsset(urlIndex, d.file_path, label, 'activity-docs');
    if (newUrl !== d.file_path && !DRY_RUN) { d.file_path = newUrl; await d.save(); }
  }
}

async function migrateMonthlyReports(urlIndex) {
  console.log('\n== Monthly reports ==');
  const reports = await MonthlyReport.find({ file_url: { $exists: true, $ne: null } });
  for (const r of reports) {
    const owner = await User.findById(r.user_id).select('emp_id name').lean();
    const label = folderLabel(owner?.name, owner?.emp_id || r.user_id);
    if (!r.public_id) { console.warn(`  ! MonthlyReport ${r._id} has no public_id, skipping`); continue; }
    const to_public_id = `ams/employees/${label}/monthly_reports/${r.public_id.split('/').pop()}`;
    if (r.file_url.includes('/ams/employees/')) continue;
    if (DRY_RUN) { console.log(`  [dry-run] ${r.public_id} -> ${to_public_id}`); continue; }
    const resource_type = r.file_type?.startsWith('image/') || r.file_type === 'application/pdf' ? 'image' : 'raw';
    const result = await cloudinary.uploader.rename(r.public_id, to_public_id, { resource_type, overwrite: false });
    r.file_url  = result.secure_url;
    r.public_id = result.public_id;
    await r.save();
    console.log(`  moved -> ${result.secure_url}`);
  }
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(DRY_RUN ? 'Running in DRY-RUN mode (no changes will be made)\n' : 'Running migration for real\n');

  console.log('Indexing existing Cloudinary resources under old folders...');
  const urlIndex = await buildUrlIndex();
  console.log(`Indexed ${urlIndex.size} resources.`);

  await migrateProfilePhotos(urlIndex);
  await migrateScansAndSignedReports(urlIndex);
  await migrateAttendanceSelfiesAndReapplyDocs(urlIndex);
  await migrateActivityDocs(urlIndex);
  await migrateMonthlyReports(urlIndex);

  console.log('\nDone.');
  await mongoose.disconnect();
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });