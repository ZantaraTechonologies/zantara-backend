const crypto = require('crypto');
const User = require('../models/User');

const PHONE_VERIFICATION_SECURITY = Object.freeze({
    OTP_TTL_MS: 10 * 60 * 1000,
    REQUEST_COOLDOWN_MS: 60 * 1000,
    MAX_OTP_ATTEMPTS: 5
});

const phoneVerificationError = (message = 'Invalid or expired verification code', statusCode = 400, code = 'INVALID_PHONE_VERIFICATION') => {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    return error;
};

const phoneOtpSecret = () => {
    const secret = process.env.PHONE_OTP_SECRET || process.env.RESET_OTP_SECRET || process.env.JWT_SECRET;
    if (!secret) throw new Error('Phone verification secret is not configured');
    return secret;
};

const generatePhoneOtp = () => crypto.randomInt(0, 1000000).toString().padStart(6, '0');

const digestPhoneOtp = (userId, challengeId, phone, otp) => crypto
    .createHmac('sha256', phoneOtpSecret())
    .update(`phone_verification:${String(userId)}:${challengeId}:${String(phone)}:${String(otp)}`)
    .digest('hex');

const safeDigestEqual = (left, right) => {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const leftBuffer = Buffer.from(left, 'hex');
    const rightBuffer = Buffer.from(right, 'hex');
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const issuePhoneVerificationChallenge = async userId => {
    const now = new Date();
    const user = await User.findOne({ _id: userId, status: true })
        .select('phone status +phoneVerificationRequestedAt');

    if (!user?.phone) throw phoneVerificationError();

    const lastRequestedAt = user.phoneVerificationRequestedAt;
    if (lastRequestedAt && lastRequestedAt > new Date(now.getTime() - PHONE_VERIFICATION_SECURITY.REQUEST_COOLDOWN_MS)) {
        throw phoneVerificationError(
            'Please wait before requesting another verification code',
            429,
            'PHONE_OTP_COOLDOWN'
        );
    }

    const phone = String(user.phone).trim();
    const challengeId = crypto.randomUUID();
    const otp = generatePhoneOtp();
    const phoneVerificationOtpDigest = digestPhoneOtp(user._id, challengeId, phone, otp);
    const cooldownBoundary = new Date(now.getTime() - PHONE_VERIFICATION_SECURITY.REQUEST_COOLDOWN_MS);

    const issued = await User.findOneAndUpdate(
        {
            _id: user._id,
            status: true,
            phone,
            $or: [
                { phoneVerificationRequestedAt: { $exists: false } },
                { phoneVerificationRequestedAt: { $lte: cooldownBoundary } }
            ]
        },
        {
            $set: {
                phoneVerificationChallengeId: challengeId,
                phoneVerificationOtpDigest,
                phoneVerificationPhone: phone,
                phoneVerificationExpiresAt: new Date(now.getTime() + PHONE_VERIFICATION_SECURITY.OTP_TTL_MS),
                phoneVerificationAttempts: 0,
                phoneVerificationRequestedAt: now
            }
        },
        { new: true }
    ).select('phone status');

    if (!issued) {
        throw phoneVerificationError(
            'Please wait before requesting another verification code',
            429,
            'PHONE_OTP_COOLDOWN'
        );
    }

    return { user: issued, otp, challengeId };
};

const invalidatePhoneVerificationChallenge = async (userId, challengeId, phone) => {
    await User.findOneAndUpdate(
        {
            _id: userId,
            phone: String(phone),
            phoneVerificationChallengeId: challengeId
        },
        {
            $unset: {
                phoneVerificationChallengeId: 1,
                phoneVerificationOtpDigest: 1,
                phoneVerificationPhone: 1,
                phoneVerificationExpiresAt: 1,
                phoneVerificationAttempts: 1,
                phoneVerificationRequestedAt: 1
            }
        }
    );
};

const verifyPhoneVerificationChallenge = async (userId, otp) => {
    const now = new Date();
    const user = await User.findOne({ _id: userId, status: true })
        .select([
            'phone',
            'status',
            '+phoneVerificationChallengeId',
            '+phoneVerificationOtpDigest',
            '+phoneVerificationPhone',
            '+phoneVerificationExpiresAt',
            '+phoneVerificationAttempts'
        ].join(' '));

    const attempts = Number(user?.phoneVerificationAttempts || 0);
    const challengeIsActive = user &&
        user.phoneVerificationChallengeId &&
        user.phoneVerificationOtpDigest &&
        user.phoneVerificationPhone &&
        String(user.phone) === String(user.phoneVerificationPhone) &&
        user.phoneVerificationExpiresAt &&
        user.phoneVerificationExpiresAt > now &&
        attempts < PHONE_VERIFICATION_SECURITY.MAX_OTP_ATTEMPTS;

    if (!challengeIsActive) throw phoneVerificationError();

    const suppliedDigest = digestPhoneOtp(
        user._id,
        user.phoneVerificationChallengeId,
        user.phoneVerificationPhone,
        otp
    );

    if (!safeDigestEqual(suppliedDigest, user.phoneVerificationOtpDigest)) {
        await User.findOneAndUpdate(
            {
                _id: user._id,
                status: true,
                phone: user.phoneVerificationPhone,
                phoneVerificationChallengeId: user.phoneVerificationChallengeId,
                phoneVerificationOtpDigest: user.phoneVerificationOtpDigest,
                phoneVerificationExpiresAt: { $gt: now },
                phoneVerificationAttempts: { $lt: PHONE_VERIFICATION_SECURITY.MAX_OTP_ATTEMPTS }
            },
            { $inc: { phoneVerificationAttempts: 1 } }
        );
        throw phoneVerificationError();
    }

    const verified = await User.findOneAndUpdate(
        {
            _id: user._id,
            status: true,
            phone: user.phoneVerificationPhone,
            phoneVerificationChallengeId: user.phoneVerificationChallengeId,
            phoneVerificationOtpDigest: user.phoneVerificationOtpDigest,
            phoneVerificationPhone: user.phoneVerificationPhone,
            phoneVerificationExpiresAt: { $gt: now },
            phoneVerificationAttempts: { $lt: PHONE_VERIFICATION_SECURITY.MAX_OTP_ATTEMPTS }
        },
        {
            $set: { isPhoneVerified: true },
            $unset: {
                phoneVerificationChallengeId: 1,
                phoneVerificationOtpDigest: 1,
                phoneVerificationPhone: 1,
                phoneVerificationExpiresAt: 1,
                phoneVerificationAttempts: 1,
                phoneVerificationRequestedAt: 1,
                otp: 1,
                otpExpires: 1
            }
        },
        { new: true }
    );

    if (!verified) throw phoneVerificationError();
    return verified;
};

module.exports = {
    PHONE_VERIFICATION_SECURITY,
    digestPhoneOtp,
    generatePhoneOtp,
    issuePhoneVerificationChallenge,
    invalidatePhoneVerificationChallenge,
    phoneVerificationError,
    safeDigestEqual,
    verifyPhoneVerificationChallenge
};
