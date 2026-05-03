const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
require('dotenv').config();

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'zantara/kyc',
        allowed_formats: ['jpg', 'jpeg', 'png', 'pdf'],
        public_id: (req, file) => {
            const userId = req.user ? req.user.id : 'anonymous';
            return `${userId}-${Date.now()}`;
        }
    }
});

module.exports = { cloudinary, storage };
