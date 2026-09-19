const Kyc = require('../models/Kyc');
const User = require('../models/User');
const mongoose = require('mongoose');
const { sendResponse } = require('../utils/response');
const notificationService = require('../services/notification.service');
const cloudinaryUtils = require('../utils/cloudinary');

const sensitiveDocumentFields = [
    'documentImage',
    'documentPublicId',
    'documentResourceType',
    'documentDeliveryType',
    'documentFormat'
];

const serializeKyc = (kyc) => {
    if (!kyc) return kyc;
    const data = typeof kyc.toObject === 'function' ? kyc.toObject() : { ...kyc };
    sensitiveDocumentFields.forEach(field => delete data[field]);
    return data;
};

const cleanupReference = (file) => {
    const publicId = typeof file?.public_id === 'string' ? file.public_id.trim() : '';
    if (!publicId) return null;
    return {
        publicId,
        resourceType: typeof file.resource_type === 'string' && file.resource_type
            ? file.resource_type
            : cloudinaryUtils.KYC_RESOURCE_TYPE,
        deliveryType: typeof file.type === 'string' && file.type
            ? file.type
            : cloudinaryUtils.KYC_DELIVERY_TYPE
    };
};

const cleanupUploadedDocument = async (file) => {
    const reference = cleanupReference(file);
    if (!reference) return;
    try {
        await cloudinaryUtils.destroyKycAsset(reference);
    } catch (err) {
        console.error('KYC document cleanup failed');
    }
};

const validatedDocumentAsset = (file) => {
    if (!file || typeof file !== 'object') return null;

    const publicId = typeof file.public_id === 'string' ? file.public_id.trim() : '';
    const resourceType = typeof file.resource_type === 'string' ? file.resource_type.trim() : '';
    const deliveryType = typeof file.type === 'string' ? file.type.trim() : '';
    const format = typeof file.format === 'string' ? file.format.trim().toLowerCase() : '';

    let secureUrl;
    try {
        secureUrl = new URL(file.secure_url);
    } catch (err) {
        return null;
    }

    if (
        !publicId ||
        resourceType !== cloudinaryUtils.KYC_RESOURCE_TYPE ||
        deliveryType !== cloudinaryUtils.KYC_DELIVERY_TYPE ||
        !['jpg', 'jpeg', 'png', 'pdf'].includes(format) ||
        secureUrl.protocol !== 'https:'
    ) {
        return null;
    }

    return { publicId, resourceType, deliveryType, format };
};

const validatedStoredDocumentAsset = (kyc) => {
    const publicId = typeof kyc?.documentPublicId === 'string' ? kyc.documentPublicId.trim() : '';
    const resourceType = typeof kyc?.documentResourceType === 'string' ? kyc.documentResourceType.trim() : '';
    const deliveryType = typeof kyc?.documentDeliveryType === 'string' ? kyc.documentDeliveryType.trim() : '';
    const format = typeof kyc?.documentFormat === 'string' ? kyc.documentFormat.trim().toLowerCase() : '';

    if (
        !publicId ||
        resourceType !== cloudinaryUtils.KYC_RESOURCE_TYPE ||
        deliveryType !== cloudinaryUtils.KYC_DELIVERY_TYPE ||
        !['jpg', 'jpeg', 'png', 'pdf'].includes(format)
    ) {
        return null;
    }

    return { publicId, resourceType, deliveryType, format };
};

const submitKyc = async (req, res) => {
    const { tier, documentType, documentNumber, address } = req.body;
    const userId = req.user.id;

    if (!req.file) {
        return sendResponse(res, { status: 400, success: false, message: 'Identity document is required' });
    }

    const documentAsset = validatedDocumentAsset(req.file);
    if (!documentAsset) {
        await cleanupUploadedDocument(req.file);
        return sendResponse(res, { status: 502, success: false, message: 'Document upload returned invalid metadata' });
    }

    if (!tier || !documentType || !documentNumber) {
        await cleanupUploadedDocument(req.file);
        return sendResponse(res, { status: 400, success: false, message: 'Missing required fields' });
    }

    let existingPending;
    try {
        existingPending = await Kyc.findOne({ userId, status: 'pending' });
    } catch (err) {
        await cleanupUploadedDocument(req.file);
        return sendResponse(res, { status: 500, success: false, message: 'Unable to submit KYC' });
    }
    if (existingPending) {
        await cleanupUploadedDocument(req.file);
        return sendResponse(res, { status: 400, success: false, message: 'You already have a verification request under review' });
    }

    let kyc;
    try {
        kyc = await Kyc.create({
            userId,
            tier,
            documentType,
            documentNumber,
            address,
            documentPublicId: documentAsset.publicId,
            documentResourceType: documentAsset.resourceType,
            documentDeliveryType: documentAsset.deliveryType,
            documentFormat: documentAsset.format,
            status: 'pending'
        });
    } catch (err) {
        await cleanupUploadedDocument(req.file);
        return sendResponse(res, { status: 500, success: false, message: 'Unable to submit KYC' });
    }

    try {
        await notificationService.sendInApp(userId, {
            title: 'KYC Documents Received',
            message: 'Your verification documents have been received and are currently under review. Our team will notify you once processed.',
            type: 'kyc',
            metadata: { kycId: kyc._id, tier }
        });
    } catch (err) {
        console.error('KYC submission notification failed');
    }

    return sendResponse(res, {
        message: 'KYC submitted successfully and is pending review',
        data: serializeKyc(kyc)
    });
};

const getMyKyc = async (req, res) => {
    try {
        const kyc = await Kyc.findOne({ userId: req.user.id }).sort({ createdAt: -1 });
        return sendResponse(res, { data: serializeKyc(kyc) });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

// Admin Endpoints
const getAllKyc = async (req, res) => {
    try {
        const { status } = req.query;
        const query = status ? { status } : {};
        
        const kycList = await Kyc.find(query).populate('userId', 'name email').sort({ createdAt: -1 });
        return sendResponse(res, { data: kycList.map(serializeKyc) });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

const getKycById = async (req, res) => {
    try {
        const kyc = await Kyc.findById(req.params.id).populate('userId', 'name email phone');
        if (!kyc) return sendResponse(res, { status: 404, success: false, message: 'KYC not found' });
        return sendResponse(res, { data: serializeKyc(kyc) });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

const getKycDocumentAccess = async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
        return sendResponse(res, { status: 400, success: false, message: 'Invalid KYC ID' });
    }

    let kyc;
    try {
        kyc = await Kyc.findById(req.params.id).select(
            '+documentImage +documentPublicId +documentResourceType +documentDeliveryType +documentFormat'
        );
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: 'Unable to access KYC document' });
    }

    if (!kyc) {
        return sendResponse(res, { status: 404, success: false, message: 'KYC not found' });
    }

    const asset = validatedStoredDocumentAsset(kyc);
    if (!asset) {
        return sendResponse(res, {
            status: 409,
            success: false,
            message: 'KYC document requires secure migration'
        });
    }

    try {
        const access = cloudinaryUtils.generateKycDocumentAccess(asset);
        res.set('Cache-Control', 'no-store');
        return sendResponse(res, { data: access });
    } catch (err) {
        return sendResponse(res, { status: 502, success: false, message: 'Unable to access KYC document' });
    }
};

const reviewKyc = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, rejectionReason } = req.body;

        if (!['approved', 'rejected'].includes(status)) {
            return sendResponse(res, { status: 400, success: false, message: 'Invalid status' });
        }

        const kyc = await Kyc.findById(id).select(
            '+documentPublicId +documentResourceType +documentDeliveryType +documentFormat'
        );
        if (!kyc) return sendResponse(res, { status: 404, success: false, message: 'KYC not found' });

        if (status === 'approved' && !validatedStoredDocumentAsset(kyc)) {
            return sendResponse(res, {
                status: 409,
                success: false,
                message: 'KYC document requires secure migration'
            });
        }

        kyc.status = status;
        kyc.rejectionReason = rejectionReason;
        kyc.verifiedAt = status === 'approved' ? new Date() : null;
        kyc.verifiedBy = req.user.id;
        await kyc.save();

        // ⬇️ Log Admin Action
        const { logAction } = require('./auditController');
        await logAction(
            req.user.id,
            req.user.name,
            'KYC_REVIEW',
            `KYC ID: ${kyc._id} (User: ${kyc.userId?.name || kyc.userId})`,
            { status, rejectionReason },
            'success',
            req
        );

        if (status === 'approved') {
            await User.findByIdAndUpdate(kyc.userId, { kycLevel: kyc.tier });
        }

        // ⬇️ Push/In-App Notification
        await notificationService.sendInApp(kyc.userId, {
            title: `KYC ${status.charAt(0).toUpperCase() + status.slice(1)}`,
            message: status === 'approved' 
                ? `Congratulations! Your KYC Tier ${kyc.tier || 1} verification has been approved.`
                : `Your KYC verification request was rejected. Reason: ${rejectionReason || 'Incomplete documents'}.`,
            type: 'kyc',
            metadata: { kycId: kyc._id, tier: kyc.tier }
        });

        return sendResponse(res, { message: `KYC ${status} successfully` });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

module.exports = { submitKyc, getMyKyc, getAllKyc, getKycById, getKycDocumentAccess, reviewKyc };
