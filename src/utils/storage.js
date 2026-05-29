const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload a buffer to Cloudinary.
 * @param {Buffer} buffer       - File buffer from multer memoryStorage
 * @param {string} folder       - Cloudinary folder e.g. 'ams/activity-docs'
 * @param {string} originalName - Original filename e.g. 'photo.jpg'
 * @param {string} mimetype     - MIME type e.g. 'image/jpeg'
 * @returns {Promise<string>} Secure HTTPS URL
 */
const uploadFile = (buffer, folder, originalName = '', mimetype = '') => {
  return new Promise((resolve, reject) => {
    const ext      = originalName.split('.').pop().toLowerCase();
    const baseName = originalName.replace(/\.[^/.]+$/, '').replace(/\s+/g, '_');
    const isImage  = mimetype.startsWith('image/');

    const options = {
      folder,
      resource_type: 'auto',
      // Images: no extension needed, Cloudinary handles format
      // Files (pdf/doc/xlsx): MUST include extension or download breaks
      public_id: isImage
        ? `${Date.now()}_${baseName}`
        : `${Date.now()}_${baseName}.${ext}`,
      ...(isImage && {
        transformation: [{ quality: 'auto', fetch_format: 'auto' }],
      }),
    };

    cloudinary.uploader.upload_stream(
      options,
      (err, result) => {
        if (err) reject(err);
        else resolve(result.secure_url);
      }
    ).end(buffer);
  });
};

const deleteFile = async () => { /* managed by Cloudinary */ };

module.exports = { uploadFile, deleteFile };