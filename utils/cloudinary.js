const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
require('dotenv').config();

if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    console.error('CRITICAL: Cloudinary environment variables are missing! Check your .env file or Render settings.');
}

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
            const pid = `${userId}-${Date.now()}`;
            console.log(`Cloudinary Upload Attempt: userId=${userId}, file=${file.originalname}, public_id=${pid}`);
            return pid;
        }
    }
});

module.exports = { cloudinary, storage };
