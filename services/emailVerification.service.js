'use strict';

const crypto = require('crypto');
const User = require('../models/User');

const EMAIL_VERIFICATION_SECURITY = Object.freeze({
    OTP_TTL_MS: 10 * 60 * 1000,
    REQUEST_COOLDOWN_MS: 60 * 1000,
    MAX_OTP_ATTEMPTS: 5
});

const emailVerificationError = (
    message = 'Invalid or expired verification code',
    statusCode = 400,
    code = 'INVALID_EMAIL_VERIFICATION'
) => {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    return error;
};

const generateEmailOtp = () => crypto.randomInt(0, 1000000).toString().padStart(6, '0');

const emailOtpSecret = () => {
    const secret = process.env.EMAIL_OTP_SECRET || process.env.RESET_OTP_SECRET || process.env.JWT_SECRET;
    if (!secret) throw new Error('Email verification secret is not configured');
    return secret;
};

const digestEmailOtp = (userId, challengeId, email, otp) => crypto
    .createHmac('sha256', emailOtpSecret())
    .update(`email_verification:${String(userId)}:${challengeId}:${String(email)}:${String(otp)}`)
    .digest('hex');

const safeDigestEqual = (left, right) => {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const leftBuffer = Buffer.from(left, 'hex');
    const rightBuffer = Buffer.from(right, 'hex');
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const issueEmailVerificationChallenge = async userId => {
    const now = new Date();
    const user = await User.findOne({ _id: userId, status: true })
        .select('name email status +emailVerificationRequestedAt');

    if (!user) throw emailVerificationError('User not found', 404, 'USER_NOT_FOUND');
    if (!user.email) {
        throw emailVerificationError(
            'No email address associated with your account',
            400,
            'EMAIL_NOT_CONFIGURED'
        );
    }

    const lastRequestedAt = user.emailVerificationRequestedAt;
    if (lastRequestedAt && lastRequestedAt > new Date(now.getTime() - EMAIL_VERIFICATION_SECURITY.REQUEST_COOLDOWN_MS)) {
        throw emailVerificationError(
            'Please wait before requesting another verification code',
            429,
            'EMAIL_OTP_COOLDOWN'
        );
    }

    const email = String(user.email).trim();
    const challengeId = crypto.randomUUID();
    const otp = generateEmailOtp();
    const emailVerificationOtpDigest = digestEmailOtp(user._id, challengeId, email, otp);
    const cooldownBoundary = new Date(now.getTime() - EMAIL_VERIFICATION_SECURITY.REQUEST_COOLDOWN_MS);
    const issued = await User.findOneAndUpdate(
        {
            _id: user._id,
            status: true,
            email,
            $or: [
                { emailVerificationRequestedAt: { $exists: false } },
                { emailVerificationRequestedAt: { $lte: cooldownBoundary } }
            ]
        },
        {
            $set: {
                emailVerificationChallengeId: challengeId,
                emailVerificationOtpDigest,
                emailVerificationEmail: email,
                emailVerificationExpiresAt: new Date(now.getTime() + EMAIL_VERIFICATION_SECURITY.OTP_TTL_MS),
                emailVerificationAttempts: 0,
                emailVerificationRequestedAt: now
            },
            $unset: {
                emailOtp: 1,
                emailOtpEmail: 1,
                emailOtpExpires: 1,
                emailOtpAttempts: 1,
                emailOtpRequestedAt: 1
            }
        },
        { new: true }
    ).select('name email status');

    if (!issued) {
        throw emailVerificationError(
            'Please wait before requesting another verification code',
            429,
            'EMAIL_OTP_COOLDOWN'
        );
    }

    return { user: issued, otp, challengeId };
};

const invalidateEmailVerificationChallenge = async (userId, challengeId, email) => {
    await User.findOneAndUpdate(
        {
            _id: userId,
            email: String(email),
            emailVerificationChallengeId: challengeId
        },
        {
            $unset: {
                emailVerificationChallengeId: 1,
                emailVerificationOtpDigest: 1,
                emailVerificationEmail: 1,
                emailVerificationExpiresAt: 1,
                emailVerificationAttempts: 1,
                emailVerificationRequestedAt: 1
            }
        }
    );
};

const verifyEmailVerificationChallenge = async (userId, otp) => {
    const now = new Date();
    const user = await User.findOne({ _id: userId, status: true })
        .select([
            'email',
            'status',
            '+emailVerificationChallengeId',
            '+emailVerificationOtpDigest',
            '+emailVerificationEmail',
            '+emailVerificationExpiresAt',
            '+emailVerificationAttempts'
        ].join(' '));
    const attempts = Number(user?.emailVerificationAttempts || 0);
    const challengeIsActive = user &&
        user.emailVerificationChallengeId &&
        user.emailVerificationOtpDigest &&
        user.emailVerificationEmail &&
        String(user.email) === String(user.emailVerificationEmail) &&
        user.emailVerificationExpiresAt &&
        user.emailVerificationExpiresAt > now &&
        attempts < EMAIL_VERIFICATION_SECURITY.MAX_OTP_ATTEMPTS;

    if (!challengeIsActive) throw emailVerificationError();

    const suppliedDigest = digestEmailOtp(
        user._id,
        user.emailVerificationChallengeId,
        user.emailVerificationEmail,
        otp
    );

    if (!safeDigestEqual(suppliedDigest, user.emailVerificationOtpDigest)) {
        await User.findOneAndUpdate(
            {
                _id: user._id,
                status: true,
                email: user.emailVerificationEmail,
                emailVerificationChallengeId: user.emailVerificationChallengeId,
                emailVerificationOtpDigest: user.emailVerificationOtpDigest,
                emailVerificationExpiresAt: { $gt: now },
                emailVerificationAttempts: { $lt: EMAIL_VERIFICATION_SECURITY.MAX_OTP_ATTEMPTS }
            },
            { $inc: { emailVerificationAttempts: 1 } }
        );
        throw emailVerificationError();
    }

    const verified = await User.findOneAndUpdate(
        {
            _id: user._id,
            status: true,
            email: user.emailVerificationEmail,
            emailVerificationChallengeId: user.emailVerificationChallengeId,
            emailVerificationOtpDigest: user.emailVerificationOtpDigest,
            emailVerificationEmail: user.emailVerificationEmail,
            emailVerificationExpiresAt: { $gt: now },
            emailVerificationAttempts: { $lt: EMAIL_VERIFICATION_SECURITY.MAX_OTP_ATTEMPTS }
        },
        {
            $set: { isEmailVerified: true },
            $unset: {
                emailVerificationChallengeId: 1,
                emailVerificationOtpDigest: 1,
                emailVerificationEmail: 1,
                emailVerificationExpiresAt: 1,
                emailVerificationAttempts: 1,
                emailVerificationRequestedAt: 1,
                emailOtp: 1,
                emailOtpEmail: 1,
                emailOtpExpires: 1,
                emailOtpAttempts: 1,
                emailOtpRequestedAt: 1
            }
        },
        { new: true }
    );

    if (!verified) throw emailVerificationError();
    return verified;
};

module.exports = {
    EMAIL_VERIFICATION_SECURITY,
    digestEmailOtp,
    emailVerificationError,
    generateEmailOtp,
    issueEmailVerificationChallenge,
    invalidateEmailVerificationChallenge,
    safeDigestEqual,
    verifyEmailVerificationChallenge
};
