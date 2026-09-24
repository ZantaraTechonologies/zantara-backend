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

const issueEmailVerificationChallenge = async userId => {
    const now = new Date();
    const user = await User.findOne({ _id: userId, status: true })
        .select('name email phone status +emailOtpRequestedAt');

    if (!user) throw emailVerificationError('User not found', 404, 'USER_NOT_FOUND');
    if (!user.email) {
        throw emailVerificationError(
            'No email address associated with your account',
            400,
            'EMAIL_NOT_CONFIGURED'
        );
    }

    const lastRequestedAt = user.emailOtpRequestedAt;
    if (lastRequestedAt && lastRequestedAt > new Date(now.getTime() - EMAIL_VERIFICATION_SECURITY.REQUEST_COOLDOWN_MS)) {
        throw emailVerificationError(
            'Please wait before requesting another verification code',
            429,
            'EMAIL_OTP_COOLDOWN'
        );
    }

    const otp = generateEmailOtp();
    const cooldownBoundary = new Date(now.getTime() - EMAIL_VERIFICATION_SECURITY.REQUEST_COOLDOWN_MS);
    const issued = await User.findOneAndUpdate(
        {
            _id: user._id,
            status: true,
            email: user.email,
            $or: [
                { emailOtpRequestedAt: { $exists: false } },
                { emailOtpRequestedAt: { $lte: cooldownBoundary } }
            ]
        },
        {
            $set: {
                emailOtp: otp,
                emailOtpEmail: user.email,
                emailOtpExpires: new Date(now.getTime() + EMAIL_VERIFICATION_SECURITY.OTP_TTL_MS),
                emailOtpAttempts: 0,
                emailOtpRequestedAt: now
            }
        },
        { new: true }
    ).select('name email phone status');

    if (!issued) {
        throw emailVerificationError(
            'Please wait before requesting another verification code',
            429,
            'EMAIL_OTP_COOLDOWN'
        );
    }

    return { user: issued, otp };
};

const verifyEmailVerificationChallenge = async (userId, otp) => {
    const now = new Date();
    const user = await User.findOne({ _id: userId, status: true })
        .select('email status +emailOtp +emailOtpEmail emailOtpExpires +emailOtpAttempts');
    const attempts = Number(user?.emailOtpAttempts || 0);
    const challengeIsActive = user &&
        user.emailOtp &&
        user.emailOtpEmail &&
        String(user.email) === String(user.emailOtpEmail) &&
        user.emailOtpExpires &&
        user.emailOtpExpires > now &&
        attempts < EMAIL_VERIFICATION_SECURITY.MAX_OTP_ATTEMPTS;

    if (!challengeIsActive) throw emailVerificationError();

    if (String(user.emailOtp) !== String(otp)) {
        await User.findOneAndUpdate(
            {
                _id: user._id,
                status: true,
                email: user.emailOtpEmail,
                emailOtp: user.emailOtp,
                emailOtpEmail: user.emailOtpEmail,
                emailOtpExpires: { $gt: now },
                emailOtpAttempts: { $lt: EMAIL_VERIFICATION_SECURITY.MAX_OTP_ATTEMPTS }
            },
            { $inc: { emailOtpAttempts: 1 } }
        );
        throw emailVerificationError();
    }

    const verified = await User.findOneAndUpdate(
        {
            _id: user._id,
            status: true,
            email: user.emailOtpEmail,
            emailOtp: user.emailOtp,
            emailOtpEmail: user.emailOtpEmail,
            emailOtpExpires: { $gt: now },
            emailOtpAttempts: { $lt: EMAIL_VERIFICATION_SECURITY.MAX_OTP_ATTEMPTS }
        },
        {
            $set: { isEmailVerified: true },
            $unset: {
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
    emailVerificationError,
    generateEmailOtp,
    issueEmailVerificationChallenge,
    verifyEmailVerificationChallenge
};
