const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const {
    TOKEN_PURPOSES,
    authVersionFilter,
    generatePasswordResetToken,
    verifyPurposeToken
} = require('../utils/authTokens');

const RESET_SECURITY = Object.freeze({
    OTP_TTL_MS: 10 * 60 * 1000,
    RESET_TOKEN_TTL_MS: 10 * 60 * 1000,
    RESET_REQUEST_COOLDOWN_MS: 60 * 1000,
    MAX_OTP_ATTEMPTS: 5
});

const securityError = (message, statusCode = 400, code = 'INVALID_RESET_AUTHORIZATION') => {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    return error;
};

const resetSecret = () => {
    const secret = process.env.RESET_OTP_SECRET || process.env.JWT_SECRET;
    if (!secret) throw new Error('Password reset secret is not configured');
    return secret;
};

const digestValue = (purpose, value) => crypto
    .createHmac('sha256', resetSecret())
    .update(`${purpose}:${value}`)
    .digest('hex');

const safeDigestEqual = (left, right) => {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const leftBuffer = Buffer.from(left, 'hex');
    const rightBuffer = Buffer.from(right, 'hex');
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const generateResetOtp = () => crypto.randomInt(0, 1000000).toString().padStart(6, '0');

const issueResetChallenge = async phone => {
    const now = new Date();
    const challengeId = crypto.randomUUID();
    const otp = generateResetOtp();
    const passwordResetOtpDigest = digestValue('password_reset_otp', `${challengeId}:${otp}`);
    const cooldownBoundary = new Date(now.getTime() - RESET_SECURITY.RESET_REQUEST_COOLDOWN_MS);

    const user = await User.findOneAndUpdate(
        {
            phone: String(phone).trim(),
            status: true,
            $or: [
                { passwordResetRequestedAt: { $exists: false } },
                { passwordResetRequestedAt: { $lte: cooldownBoundary } }
            ]
        },
        {
            $set: {
                passwordResetChallengeId: challengeId,
                passwordResetOtpDigest,
                passwordResetExpiresAt: new Date(now.getTime() + RESET_SECURITY.OTP_TTL_MS),
                passwordResetAttempts: 0,
                passwordResetRequestedAt: now
            },
            $unset: {
                passwordResetConsumedAt: 1,
                passwordResetTokenDigest: 1,
                passwordResetTokenExpiresAt: 1
            }
        },
        { new: true }
    ).select('name email phone status');

    return user ? { user, otp } : null;
};

const verifyResetChallenge = async (phone, otp) => {
    const now = new Date();
    const user = await User.findOne({ phone: String(phone).trim(), status: true })
        .select('+passwordResetChallengeId +passwordResetOtpDigest +passwordResetExpiresAt +passwordResetAttempts authVersion email role roles');

    if (!user || !user.passwordResetChallengeId || !user.passwordResetOtpDigest ||
        !user.passwordResetExpiresAt || user.passwordResetExpiresAt <= now ||
        Number(user.passwordResetAttempts || 0) >= RESET_SECURITY.MAX_OTP_ATTEMPTS) {
        throw securityError('Invalid or expired reset code');
    }

    const suppliedDigest = digestValue(
        'password_reset_otp',
        `${user.passwordResetChallengeId}:${String(otp)}`
    );

    if (!safeDigestEqual(suppliedDigest, user.passwordResetOtpDigest)) {
        await User.findOneAndUpdate(
            {
                _id: user._id,
                status: true,
                passwordResetChallengeId: user.passwordResetChallengeId,
                passwordResetExpiresAt: { $gt: now },
                passwordResetAttempts: { $lt: RESET_SECURITY.MAX_OTP_ATTEMPTS }
            },
            { $inc: { passwordResetAttempts: 1 } }
        );
        throw securityError('Invalid or expired reset code');
    }

    const jti = crypto.randomUUID();
    const passwordResetTokenDigest = digestValue('password_reset_token', jti);
    const consumed = await User.findOneAndUpdate(
        {
            _id: user._id,
            status: true,
            passwordResetChallengeId: user.passwordResetChallengeId,
            passwordResetOtpDigest: user.passwordResetOtpDigest,
            passwordResetExpiresAt: { $gt: now },
            passwordResetAttempts: { $lt: RESET_SECURITY.MAX_OTP_ATTEMPTS },
            passwordResetConsumedAt: { $exists: false }
        },
        {
            $set: {
                passwordResetConsumedAt: now,
                passwordResetTokenDigest,
                passwordResetTokenExpiresAt: new Date(now.getTime() + RESET_SECURITY.RESET_TOKEN_TTL_MS)
            },
            $unset: { passwordResetOtpDigest: 1 }
        },
        { new: true }
    ).select('email role roles authVersion');

    if (!consumed) throw securityError('Invalid or expired reset code');
    return {
        user: consumed,
        resetToken: generatePasswordResetToken(consumed, jti, '10m')
    };
};

const completePasswordReset = async (token, password) => {
    if (typeof password !== 'string' || password.length === 0) {
        throw securityError('New password is required');
    }

    let decoded;
    try {
        decoded = verifyPurposeToken(token, TOKEN_PURPOSES.PASSWORD_RESET);
    } catch (_) {
        throw securityError('Invalid or expired reset authorization');
    }
    if (!decoded.jti) throw securityError('Invalid or expired reset authorization');

    const user = await User.findById(decoded.sub)
        .select('+password +passwordHistory +passwordResetTokenDigest +passwordResetTokenExpiresAt authVersion status');
    const now = new Date();
    const expectedTokenDigest = digestValue('password_reset_token', decoded.jti);
    const currentAuthVersion = Number.isSafeInteger(user?.authVersion) ? user.authVersion : 0;

    if (!user || !user.status || currentAuthVersion !== Number(decoded.authVersion || 0) ||
        !user.passwordResetTokenExpiresAt || user.passwordResetTokenExpiresAt <= now ||
        !safeDigestEqual(expectedTokenDigest, user.passwordResetTokenDigest)) {
        throw securityError('Invalid or expired reset authorization');
    }

    if (user.password && await bcrypt.compare(password, user.password)) {
        throw securityError('New password cannot be your current password');
    }
    for (const oldHash of user.passwordHistory || []) {
        if (await bcrypt.compare(password, oldHash)) {
            throw securityError('You cannot reuse any of your last 5 passwords');
        }
    }

    const passwordHistory = user.password ? [user.password, ...(user.passwordHistory || [])].slice(0, 5) : [];
    const hashedPassword = await bcrypt.hash(password, 12);
    const updated = await User.findOneAndUpdate(
        {
            _id: user._id,
            status: true,
            passwordResetTokenDigest: expectedTokenDigest,
            passwordResetTokenExpiresAt: { $gt: now },
            ...authVersionFilter(decoded.authVersion)
        },
        {
            $set: { password: hashedPassword, passwordHistory },
            $inc: { authVersion: 1 },
            $unset: {
                passwordResetTokenDigest: 1,
                passwordResetTokenExpiresAt: 1,
                passwordResetChallengeId: 1,
                passwordResetOtpDigest: 1,
                passwordResetExpiresAt: 1,
                passwordResetAttempts: 1,
                passwordResetConsumedAt: 1
            }
        },
        { new: true }
    );

    if (!updated) throw securityError('Invalid or expired reset authorization');
    return updated;
};

module.exports = {
    RESET_SECURITY,
    generateResetOtp,
    issueResetChallenge,
    verifyResetChallenge,
    completePasswordReset,
    digestValue,
    safeDigestEqual
};
