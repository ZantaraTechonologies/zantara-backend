const Kyc = require('../models/Kyc');
const User = require('../models/User');
const { sendResponse } = require('../utils/response');
const notificationService = require('../services/notification.service');

const submitKyc = async (req, res) => {
    try {
        const { tier, documentType, documentNumber } = req.body;
        const userId = req.user.id;
        const documentImage = req.file ? req.file.path : null;

        console.log('KYC Submission:', { tier, documentType, documentNumber, userId, hasImage: !!req.file });

        if (!tier || !documentType || !documentNumber) {
            return sendResponse(res, { status: 400, success: false, message: 'Missing required fields' });
        }

        const kyc = await Kyc.create({
            userId,
            tier,
            documentType,
            documentNumber,
            documentImage,
            status: 'pending'
        });

        return sendResponse(res, { message: 'KYC submitted successfully and is pending review', data: kyc });
    } catch (err) {
        console.error('KYC Submission Error:', err);
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

const getMyKyc = async (req, res) => {
    try {
        const kyc = await Kyc.findOne({ userId: req.user.id }).sort({ createdAt: -1 });
        return sendResponse(res, { data: kyc });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

// Admin Endpoints
const getAllKyc = async (req, res) => {
    try {
        const kycList = await Kyc.find().populate('userId', 'name email').sort({ createdAt: -1 });
        return sendResponse(res, { data: kycList });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

const getKycById = async (req, res) => {
    try {
        const kyc = await Kyc.findById(req.params.id).populate('userId', 'name email phone');
        if (!kyc) return sendResponse(res, { status: 404, success: false, message: 'KYC not found' });
        return sendResponse(res, { data: kyc });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

const reviewKyc = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, rejectionReason } = req.body;

        if (!['approved', 'rejected'].includes(status)) {
            return sendResponse(res, { status: 400, success: false, message: 'Invalid status' });
        }

        const kyc = await Kyc.findById(id);
        if (!kyc) return sendResponse(res, { status: 404, success: false, message: 'KYC not found' });

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

module.exports = { submitKyc, getMyKyc, getAllKyc, getKycById, reviewKyc };
