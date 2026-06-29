/**
 * Builds a human-readable Cloudinary folder label combining the employee's
 * name and emp_id, e.g.  "Sravya(emp001)".
 *
 * Usage:
 *   const { employeeFolderLabel } = require('../utils/folderLabel');
 *   const label = await employeeFolderLabel(req.user.id);
 *   // -> ams/employees/{label}/selfies
 */
const { User } = require('../models/database');

function slugify(name) {
  return (name || 'Unknown')
    .trim()
    .replace(/[\/\\?%*:|"<>]/g, '')   // strip characters Cloudinary folder names dislike
    .replace(/\s+/g, '_');            // spaces -> underscores
}

/**
 * @param {string} userId - Mongo _id of the user
 * @param {object} [fallback] - optional {name, emp_id} to use if lookup fails
 * @returns {Promise<string>} e.g. "Sravya(emp001)"
 */
async function employeeFolderLabel(userId, fallback = {}) {
  let name = fallback.name;
  let empId = fallback.emp_id;
  if (!name || !empId) {
    const user = await User.findById(userId).select('name emp_id').lean();
    name  = name  || user?.name;
    empId = empId || user?.emp_id || userId;
  }
  return `${slugify(name)}(${empId})`;
}

module.exports = { employeeFolderLabel, slugify };