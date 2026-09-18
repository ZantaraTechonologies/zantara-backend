const User = require('../models/User')
const Wallet = require('../models/Wallet')
const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const { sendToken, clearAuthCookie } = require('../utils/authUtils')
const { TOKEN_PURPOSES, authVersionFilter, verifyPurposeToken } = require('../utils/authTokens')
const passwordResetService = require('../services/passwordReset.service')
const { sendEmail } = require('../utils/mailer')
const { sendSMS } = require('../utils/sms')
const notificationService = require('../services/notification.service')
const ActivityLog = require('../models/ActivityLog')
const { createReservedAccount } = require('../utils/monnify')
const LegalAcceptance = require('../models/LegalAcceptance')
const legalService = require('../services/legalDocument.service')
const { maskSecret } = require('../utils/logSanitizer')

const PASSWORD_RESET_RESPONSE = Object.freeze({
    success: true,
    message: 'If an account matches those details, password reset instructions will be sent.'
});

const logSecurityEvent = async event => {
    try {
        await ActivityLog.create(event);
    } catch (error) {
        console.error(`[Security Audit] ${event.action} log failed:`, error.message);
    }
};

const register = async (req, res) => {
    let { name, email, phone, password, referrerCode, referralCode } = req.body

    // Normalize referral code naming (Web vs Mobile mismatch)
    const activeReferrerCode = (referrerCode || referralCode || "").trim().toLowerCase();

    // Normalize email
    if (email) email = email.trim().toLowerCase();
    if (phone) phone = phone.trim();

    // Email, Phone, Name, and Password are REQUIRED
    if (!name || !phone || !email || !password) {
        return res.status(400).json({ message: "Name, email, phone and password are required" });
    }

    // Phase 2: legal acceptance payload (array of {documentType, version, contentHash, channel})
    const legalPayload = req.body.legalAcceptances || req.body.legalAcceptance || [];

    try {
        const phoneExists = await checkPhone(phone)
        if (phoneExists) return res.status(409).json({ message: "Phone number already in use" })

        if (email) {
            const emailExists = await checkEmail(email)
            if (emailExists) return res.status(409).json({ message: "Email address already in use" })
        }

        const myReferralCode = await generateUniqueReferralCode()
        const hashed = await bcrypt.hash(password, 12)

        let referredBy = undefined;
        if (activeReferrerCode) {
            const referrer = await User.findOne({ myReferralCode: activeReferrerCode });
            if (referrer) {
                // Prevent self-referral (Check if referrer belongs to this registration phone/email)
                if (referrer.phone === phone.trim() || (email && referrer.email === email.trim().toLowerCase())) {
                    console.log(`Self-referral attempt blocked for ${phone}`);
                } else {
                    referredBy = referrer._id;
                }
            }
        }

        const userData = {
            name,
            phone: phone.trim(),
            password: hashed,
            referrerCode: activeReferrerCode || undefined,
            referredBy,
            myReferralCode,
            role: 'user', // Never accept a role from a self-service registration
            roles: ['user'],
            isPhoneVerified: true, // Bypass OTP for now as requested
            status: true // Auto-verify account
        };

        if (email && email.trim()) {
            userData.email = email.trim().toLowerCase();
        }

        // ── Phase 2: server-side legal acceptance validation ────────────────────
        // Validates version + contentHash against the then-current published docs;
        // returns normalized rows with server-derived documentId + acceptanceType.
        const acceptanceRows = await legalService.validateSignupAcceptances(legalPayload);

        // ── Atomic: user + wallet + required acceptances ────────────────────────
        // Transaction commits ONLY after all three collections are written.
        // External calls (Monnify, notifications) run AFTER commit.
        const session = await mongoose.startSession();
        let user;
        try {
            session.startTransaction();
            user = (await User.create([userData], { session }))[0];

            await LegalAcceptance.insertMany(acceptanceRows.map(r => ({
                userId: user._id,
                documentId: r.documentId,
                documentType: r.documentType,
                version: r.version,
                channel: r.channel,
                acceptanceType: r.acceptanceType,
                contentHash: r.contentHash
            })), { session });

            await Wallet.create([{ userId: user._id }], { session });
            await session.commitTransaction();
        } catch (txErr) {
            try { await session.abortTransaction(); } catch (_) {}
            throw txErr;
        } finally {
            session.endSession();
        }

        // ── Post-commit side effects (deliberately outside transaction) ─────────

        // Notify Referrer
        if (referredBy) {
            await notificationService.sendInApp(referredBy, {
                title: 'New Network Member!',
                message: `${user.name || user.phone} has joined your network using your referral link.`,
                type: 'referral'
            });
        }

        // Auto-generate Virtual Accounts (Monnify) — must NOT run inside transaction
        try {
            const vaResult = await createReservedAccount(user);
            if (vaResult.status && vaResult.accounts) {
                user.virtualAccounts = vaResult.accounts.map(acc => ({
                    bankName: acc.bankName,
                    accountName: acc.accountName,
                    accountNumber: acc.accountNumber
                }));
                await user.save();
                console.log(`Virtual accounts auto-generated for ${phone}`);
            }
        } catch (vaError) {
            console.error(`Virtual account auto-generation failed for ${phone}:`, vaError.message);
            // We don't block registration if VA generation fails
        }

        await ActivityLog.create({
            userId: user._id,
            action: 'REGISTER',
            ipAddress: req.ip,
            device: req.headers['user-agent']
        })

        console.log(`Registration successful for user: ${phone}`);
        user.lastLogin = new Date();
        await user.save();
        sendToken(user, res)
    } catch (error) {
        console.error("Registration fatal error:", error);

        // Phase 2: legal-service validation errors (httpError shape)
        if (error.status && error.code) {
            return res.status(error.status).json({
                success: false,
                code: error.code,
                message: error.message,
                ...(error.details ? { data: error.details } : {})
            });
        }

        // Handle MongoDB Duplicate Key Errors (E11000)
        if (error.code === 11000) {
            const field = Object.keys(error.keyPattern)[0];
            const message = field === 'phone'
                ? "This phone number is already registered."
                : field === 'email'
                    ? "This email address is already in use."
                    : "A user with these details already exists.";

            return res.status(409).json({
                success: false,
                message: message
            });
        }

        res.status(500).json({
            success: false,
            message: "Registration failed. Please try again later.",
            error: error.message
        })
    }
}

const verifyEmail = async (req, res) => {
    try {
        const decoded = verifyPurposeToken(req.params.token, TOKEN_PURPOSES.EMAIL_VERIFICATION);
        const user = await User.findOneAndUpdate(
            { _id: decoded.sub, email: decoded.email, status: true },
            { $set: { isEmailVerified: true } },
            { new: true }
        );
        if (!user) return res.status(400).json({ message: 'Invalid or expired verification link' });

        await logSecurityEvent({
            userId: user._id,
            action: 'VERIFY_EMAIL',
            ipAddress: req.ip,
            device: req.headers['user-agent']
        });
        res.json({ message: 'Email verified successfully' })
    } catch (err) {
        res.status(400).json({ message: 'Invalid or expired verification link' })
    }
}

const login = async (req, res) => {
    let { identifier, email, phone, password, rememberMe } = req.body // Support 'identifier' or specific fields

    let loginId = (identifier || email || phone || "").trim().toLowerCase();

    if (!loginId || !password) {
        return res.status(400).json({ message: 'Login ID and password are required' })
    }

    try {
        // Search by email OR phone
        const user = await User.findOne({
            $or: [{ email: loginId }, { phone: loginId }]
        }).select('+password')

        if (!user) return res.status(400).json({ message: 'Invalid credentials' })

        const match = await bcrypt.compare(password, user.password)
        if (!match) return res.status(400).json({ message: 'Invalid credentials' })

        // Enforce account status (CRIT 2): disabled accounts cannot log in.
        if (!user.status) {
            return res.status(401).json({ message: 'Account is disabled' });
        }

        await ActivityLog.create({ userId: user._id, action: 'LOGIN', ipAddress: req.ip, device: req.headers['user-agent'] })

        user.lastLogin = new Date();
        await user.save();

        // Security notification for new login
        await notificationService.sendInApp(user._id, {
            title: 'Security Alert: New Login',
            message: `A login was detected on your account from ${req.headers['user-agent']?.split(' ')[0] || 'Unknown Device'} (${req.ip}). If this wasn't you, secure your account immediately.`,
            type: 'security'
        });

        sendToken(user, res, 200, rememberMe === true ? '30d' : '7d')
    } catch (error) {
        res.status(500).json({ message: 'Internal server error' })
    }
}

const profile = async (req, res) => {
    const user = await User.findById(req.user.id).select('-password')
    res.json(user)
}

const checkPhone = async (phone) => {
    if (!phone) return false

    const existingUserPhone = await User.findOne({ phone })
    return !!existingUserPhone
}

const checkEmail = async (email) => {
    if (!email) return false

    const existingUserEmail = await User.findOne({ email })
    if (existingUserEmail) {
        return !!existingUserEmail
    }
}

const generateUniqueReferralCode = async () => {
    let code
    let isUnique = false

    while (!isUnique) {
        code = crypto.randomBytes(4).toString('hex') // e.g., 'a9f1d3c2'
        const existing = await User.findOne({ myReferralCode: code })
        if (!existing) isUnique = true
    }

    return code
}

// Only non-privileged, self-editable profile fields may be written by a user
// updating their own account. Privileged fields (role, roles, accountType,
// status, permissions, isShareholder, ...) are deliberately excluded.
const SELF_EDITABLE_FIELDS = ['name', 'email', 'phone'];

const updateUser = async (req, res) => {
    try {
        const { id } = req.params

        // Only allow if logged-in user matches the ID in the param
        if (req.user.id !== id) {
            return res.status(403).json({ message: "Unauthorized to update this user." })
        }

        const body = req.body || {}

        // Explicit allowlist: copy only approved self-editable fields.
        const updateFields = {}
        for (const field of SELF_EDITABLE_FIELDS) {
            if (body[field]) updateFields[field] = body[field]
        }

        // Track any privileged/unknown fields the client attempted to set.
        const blockedFields = Object.keys(body).filter(key => !SELF_EDITABLE_FIELDS.includes(key))

        const updatedUser = await User.findByIdAndUpdate(
            id,
            updateFields,
            { new: true, runValidators: true }
        );

        await ActivityLog.create({
            userId: req.user.id,
            action: 'UPDATE_PROFILE',
            ipAddress: req.ip,
            device: req.headers['user-agent'],
            details: {
                targetUserId: id,
                updates: Object.keys(updateFields),
                ...(blockedFields.length ? { blockedFields } : {})
            }
        })

        if (!updatedUser) {
            return res.status(404).json({ message: "User not found." })
        }

        sendToken(updatedUser, res)
    } catch (error) {
        res.status(500).json({ message: "Server error.", error: error.message })
    }
}

const forgotPassword = async (req, res) => {
    const genericResetResponse = PASSWORD_RESET_RESPONSE;
    try {
        const { phone } = req.body;
        if (!phone) return res.status(400).json({ message: 'Phone number is required' });

        const challenge = await passwordResetService.issueResetChallenge(phone);
        if (!challenge) return res.json(genericResetResponse);

        const { user, otp } = challenge;
        const deliveries = [
            sendSMS(user.phone, `Your Zantara password reset code is: ${otp}. Valid for 10 minutes.`, 'password_reset')
        ];
        if (user.email) {
            const html = `
                <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                    <h2>Password Reset Request</h2>
                    <p>Hello ${user.name || 'User'},</p>
                    <p>We received a request to reset your password. Your verification code is:</p>
                    <h1 style="color: #136A63; letter-spacing: 5px;">${otp}</h1>
                    <p>This code is valid for 10 minutes. If you did not request this, please ignore this email.</p>
                    <br />
                    <p>Regards,<br>The Zantara Team</p>
                </div>
            `;
            deliveries.push(sendEmail(user.email, 'Your Zantara Password Reset Code', html, 'password_reset'));
        }

        Promise.allSettled(deliveries).then(deliveryResults => {
            if (deliveryResults.some(result => result.status === 'rejected' ||
                result.value === null || result.value?.success === false)) {
                console.error('[Password Reset] One or more delivery channels failed');
            }
        });
        logSecurityEvent({
            userId: user._id,
            action: 'PASSWORD_RESET_REQUESTED',
            ipAddress: req.ip,
            device: req.headers['user-agent']
        });
        res.json(genericResetResponse);
    } catch (error) {
        console.error('[Password Reset] Request processing failed');
        res.json(genericResetResponse);
    }
}

const verifyResetOTP = async (req, res) => {
    try {
        const { phone, otp } = req.body;
        if (!phone || !otp) return res.status(400).json({ message: 'Phone and OTP are required' });

        const { resetToken } = await passwordResetService.verifyResetChallenge(phone, otp);
        res.json({ success: true, token: resetToken, message: 'Reset code verified' });
    } catch (error) {
        res.status(error.statusCode || 400).json({ message: 'Invalid or expired reset code' });
    }
}

const resetPassword = async (req, res) => {
    try {
        const { password } = req.body;
        const user = await passwordResetService.completePasswordReset(req.params.token, password);
        await logSecurityEvent({
            userId: user._id,
            action: 'PASSWORD_RESET_COMPLETED',
            ipAddress: req.ip,
            device: req.headers['user-agent']
        });
        await notificationService.sendInApp(user._id, {
            title: 'Password Restored',
            message: 'Your Zantara account password has been successfully reset.',
            type: 'security'
        }).catch(error => console.error('[Password Reset] Notification failed:', error.message));

        res.json({
            success: true,
            message: 'Password reset successful. Please sign in with your new password.',
            reauthenticationRequired: true
        });
    } catch (err) {
        res.status(err.statusCode || 400).json({ message: err.message || 'Invalid or expired reset authorization' });
    }
}

const logout = (req, res) => {
    clearAuthCookie(res)
    return res.json({ ok: true })
};

const sendOTP = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

        await User.findByIdAndUpdate(user._id, { otp, otpExpires });

        // Map the incoming 'purpose' to the correct admin-controlled activityType toggle
        const purpose = req.body?.purpose || 'phone_verification';
        const validPurposes = ['phone_verification', 'change_pin', 'change_password'];
        const activityType = validPurposes.includes(purpose) ? purpose : 'phone_verification';

        await sendSMS(user.phone, `Your Zantara verification code is: ${otp}. Valid for 10 minutes.`, activityType);

        if (user.email) {
            const html = `
                <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                    <h2>Verification Code</h2>
                    <p>Hello ${user.name || 'User'},</p>
                    <p>Your Zantara verification code is:</p>
                    <h1 style="color: #136A63; letter-spacing: 5px;">${otp}</h1>
                    <p>This code is valid for 10 minutes. Please do not share this code with anyone.</p>
                    <br />
                    <p>Regards,<br>The Zantara Team</p>
                </div>
            `;
            await sendEmail(user.email, 'Your Zantara Verification Code', html, activityType);
        }

        // Also send as in-app notification (security fallback)
        await notificationService.sendInApp(user._id, {
            title: 'Verification OTP',
            message: `Your verification code is: ${otp}. Valid for 10 minutes.`,
            type: 'security'
        });

        res.json({ success: true, message: 'OTP sent successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error sending OTP', error: error.message });
    }
};

const changePassword = async (req, res) => {
    try {
        const { newPassword, oldPassword } = req.body;
        const currentPassword = req.body.currentPassword || oldPassword;
        const userId = req.user.id;

        if (!currentPassword) {
            return res.status(400).json({ message: "Current password is required." });
        }
        if (!newPassword) {
            return res.status(400).json({ message: "New password is required." });
        }

        // Fetch user with password and history
        const user = await User.findById(userId).select('+password +passwordHistory authVersion');
        if (!user) return res.status(404).json({ message: "User not found." });

        const currentPasswordMatches = await bcrypt.compare(currentPassword, user.password);
        if (!currentPasswordMatches) {
            return res.status(400).json({ message: "Current password is incorrect." });
        }

        // Check if new password matches current password
        if (user.password) {
            const isMatch = await bcrypt.compare(newPassword, user.password);
            if (isMatch) {
                return res.status(400).json({ message: "New password cannot be the same as your current password." });
            }
        }

        // Check against password history (last 5)
        if (user.passwordHistory && user.passwordHistory.length > 0) {
            for (const oldHashedPassword of user.passwordHistory) {
                const isMatch = await bcrypt.compare(newPassword, oldHashedPassword);
                if (isMatch) {
                    return res.status(400).json({ message: "You cannot reuse any of your last 5 passwords." });
                }
            }
        }

        // Prepare new history
        let newHistory = user.passwordHistory || [];
        if (user.password) {
            newHistory.unshift(user.password);
            if (newHistory.length > 5) {
                newHistory = newHistory.slice(0, 5);
            }
        }

        const hashed = await bcrypt.hash(newPassword, 12);
        const currentAuthVersion = Number.isSafeInteger(user.authVersion) ? user.authVersion : 0;
        const updated = await User.findOneAndUpdate(
            {
                _id: userId,
                status: true,
                password: user.password,
                ...authVersionFilter(currentAuthVersion)
            },
            {
                $set: { password: hashed, passwordHistory: newHistory },
                $inc: { authVersion: 1 }
            },
            { new: true }
        );
        if (!updated) {
            return res.status(409).json({ message: 'Password changed concurrently. Please sign in and try again.' });
        }

        await ActivityLog.create({ 
            userId, 
            action: 'CHANGE_PASSWORD', 
            ipAddress: req.ip, 
            device: req.headers['user-agent'] 
        });

        res.json({
            success: true,
            message: "Password updated successfully. Please sign in again.",
            reauthenticationRequired: true
        });
 
        // Notify User
        await notificationService.sendInApp(userId, {
            title: 'Security Alert: Password Changed',
            message: 'Your account password was recently changed. If this wasn\'t you, please contact support immediately.',
            type: 'security'
        });
    } catch (error) {
        res.status(500).json({ message: "Error updating password.", error: error.message });
    }
};

const verifyOTP = async (req, res) => {
    try {
        const { otp } = req.body;
        if (!otp) return res.status(400).json({ message: 'OTP is required' });

        const user = await User.findOneAndUpdate(
            {
                _id: req.user.id,
                status: true,
                otp: String(otp),
                otpExpires: { $gt: new Date() }
            },
            {
                $set: { isPhoneVerified: true },
                $unset: { otp: 1, otpExpires: 1 }
            },
            { new: true }
        );
        if (!user) return res.status(400).json({ message: 'Invalid or expired OTP' });

        res.json({ success: true, message: 'Phone verified successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error verifying OTP', error: error.message });
    }
};

const sendEmailOTP = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: 'User not found' });
        if (!user.email) return res.status(400).json({ message: 'No email address associated with your account' });

        const emailOtp = Math.floor(100000 + Math.random() * 900000).toString();
        const emailOtpExpires = new Date(Date.now() + 10 * 60 * 1000);

        await User.findByIdAndUpdate(user._id, { emailOtp, emailOtpExpires });

        const html = `
            <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                <h2>Confirm Your Email</h2>
                <p>Hello ${user.name || 'User'},</p>
                <p>Your Zantara verification code is:</p>
                <h1 style="color: #136A63; letter-spacing: 5px;">${emailOtp}</h1>
                <p>This code is valid for 10 minutes. Please do not share this code with anyone.</p>
                <br />
                <p>Regards,<br>The Zantara Team</p>
            </div>
        `;
        await sendEmail(user.email, 'Your Zantara Verification Code', html, 'email_verification');

        if (user.phone) {
            await sendSMS(user.phone, `Your Zantara verification code is: ${emailOtp}. Valid for 10 minutes.`, 'email_verification');
        }

        res.json({ success: true, message: 'OTP sent to email successfully' });

        // Security fallback in-app & Push
        await notificationService.sendInApp(user._id, {
            title: 'Verification Code',
            message: `Your code is: ${emailOtp}. Valid for 10 minutes.`,
            type: 'security'
        });
    } catch (error) {
        res.status(500).json({ message: 'Error sending email OTP', error: error.message });
    }
};

const verifyEmailOTP = async (req, res) => {
    try {
        const { otp } = req.body;
        if (!otp) return res.status(400).json({ message: 'OTP is required' });

        const user = await User.findById(req.user.id).select('+emailOtp');
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (user.emailOtp !== otp || user.emailOtpExpires < Date.now()) {
            return res.status(400).json({ message: 'Invalid or expired OTP' });
        }

        await User.findByIdAndUpdate(user._id, {
            isEmailVerified: true,
            emailOtp: null,
            emailOtpExpires: null
        });

        res.json({ success: true, message: 'Email verified successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error verifying email OTP', error: error.message });
    }
};
 
const getReferralStats = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: 'User not found' });
 
        // 1. Get referred users (limit to 20 for now)
        const referrals = await User.find({ referrerCode: user.myReferralCode })
            .select('name phone createdAt')
            .sort({ createdAt: -1 })
            .limit(20);
 
        // 2. Get total count
        const totalReferrals = await User.countDocuments({ referrerCode: user.myReferralCode });
 
        res.json({
            success: true,
            totalReferrals,
            referrals,
            referralBalance: user.referralBalance || 0,
            totalReferralBonus: user.totalReferralBonus || 0
        });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching referral stats', error: error.message });
    }
};
 
const savePushToken = async (req, res) => {
    try {
        const { pushToken } = req.body;
        console.log(`[Push Token Registration] User: ${req.user.id}, Token: ${maskSecret(pushToken)}`);
        
        if (!pushToken) {
            return res.status(400).json({ success: false, message: 'Push token is required' });
        }
        
        // Ensure it looks like a valid Expo token
        if (!pushToken.startsWith('ExponentPushToken')) {
            return res.status(400).json({ success: false, message: 'Invalid token format' });
        }

        await User.findByIdAndUpdate(req.user.id, { pushToken });
        res.json({ success: true, message: 'Push token saved' });
    } catch (error) {
        console.error('[Push Token Registration Error]:', error.message);
        res.status(500).json({ message: 'Error saving push token', error: error.message });
    }
};

module.exports = {
    register,
    login,
    profile,
    updateUser,
    forgotPassword,
    resetPassword,
    verifyEmail,
    logout,
    sendOTP,
    verifyOTP,
    sendEmailOTP,
    verifyEmailOTP,
    getReferralStats,
    changePassword,
    verifyResetOTP,
    savePushToken
}