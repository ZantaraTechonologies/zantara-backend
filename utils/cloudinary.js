const cloudinarySdk = require('cloudinary');
const cloudinary = cloudinarySdk.v2;
const CloudinaryStorage = require('multer-storage-cloudinary');
const crypto = require('crypto');
require('dotenv').config();

const KYC_DELIVERY_TYPE = 'authenticated';
const KYC_RESOURCE_TYPE = 'image';
const KYC_ACCESS_TTL_SECONDS = 5 * 60;

if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    console.error('CRITICAL: Cloudinary environment variables are missing! Check your .env file or Render settings.');
}

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinarySdk,
    params: (req, file, callback) => {
        callback(null, {
            folder: 'zantara/kyc',
            allowed_formats: ['jpg', 'jpeg', 'png', 'pdf'],
            public_id: `document-${crypto.randomBytes(16).toString('hex')}`,
            resource_type: KYC_RESOURCE_TYPE,
            type: KYC_DELIVERY_TYPE,
            overwrite: false
        });
    }
});

const destroyKycAsset = ({ publicId, resourceType, deliveryType }) => {
    return cloudinary.uploader.destroy(publicId, {
        resource_type: resourceType,
        type: deliveryType,
        invalidate: true
    });
};

const generateKycDocumentAccess = ({ publicId, resourceType, deliveryType, format }) => {
    const expiresAt = Math.floor(Date.now() / 1000) + KYC_ACCESS_TTL_SECONDS;
    const url = cloudinary.utils.private_download_url(publicId, format, {
        resource_type: resourceType,
        type: deliveryType,
        expires_at: expiresAt,
        attachment: true
    });

    return { url, expiresAt };
};

module.exports = {
    cloudinary,
    storage,
    destroyKycAsset,
    generateKycDocumentAccess,
    KYC_DELIVERY_TYPE,
    KYC_RESOURCE_TYPE
};
