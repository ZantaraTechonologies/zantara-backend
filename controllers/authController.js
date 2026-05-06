const User = require('../models/User')
const Wallet = require('../models/Wallet')
const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const { generateToken, sendToken, cookieOpts, clearAuthCookie } = require('../utils/authUtils')
const { sendEmail } = require('../utils/mailer')
const { sendSMS } = require('../utils/sms')
const notificationService = require('../services/notification.service')
const ActivityLog = require('../models/ActivityLog')
const { createReservedAccount } = require('../utils/monnify')

const register = async (req, res) => {
    let { name, email, phone, password, referrerCode, referralCode, role } = req.body
    
    // Normalize referral code naming (Web vs Mobile mismatch)
    const activeReferrerCode = (referrerCode || referralCode || "").trim().toLowerCase();
    
    // Normalize email
    if (email) email = email.trim().toLowerCase();
    if (phone) phone = phone.trim();

    // Email, Phone, Name, and Password are REQUIRED
    if (!name || !phone || !email || !password) {
        return res.status(400).json({ message: "Name, email, phone and password are required" });
    }

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
            role: role || 'user',
            roles: [role || 'user'],
            isPhoneVerified: true, // Bypass OTP for now as requested
            status: true // Auto-verify account
        };

        if (email && email.trim()) {
            userData.email = email.trim().toLowerCase();
        }

        const user = await User.create(userData);

        // Notify Referrer
        if (referredBy) {
            await notificationService.sendInApp(referredBy, {
                title: 'New Network Member!',
                message: `${user.name || user.phone} has joined your network using your referral link.`,
                type: 'referral'
            });
        }

        await Wallet.create({ userId: user._id })

        // Auto-generate Virtual Accounts (Monnify)
        try {
            const vaResult = await createReservedAccount(user);
            if (vaResult.status) {
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
        const decoded = jwt.verify(req.params.token, process.env.JWT_SECRET)
        console.log(decoded)
        await User.findByIdAndUpdate(decoded.id, { status: true })
        res.json({ message: 'Email verified successfully' })
    } catch (err) {
        res.status(400).json({ message: 'Invalid or expired verification link' })
    }
}

const login = async (req, res) => {
    let { identifier, email, phone, password } = req.body // Support 'identifier' or specific fields

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

        await ActivityLog.create({ userId: user._id, action: 'LOGIN', ipAddress: req.ip, device: req.headers['user-agent'] })

        user.lastLogin = new Date();
        await user.save();

        // Security notification for new login
        await notificationService.sendInApp(user._id, {
            title: 'Security Alert: New Login',
            message: `A login was detected on your account from ${req.headers['user-agent']?.split(' ')[0] || 'Unknown Device'} (${req.ip}). If this wasn't you, secure your account immediately.`,
            type: 'security'
        });

        sendToken(user, res)
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

const updateUser = async (req, res) => {
    try {
        const { id } = req.params

        // Only allow if logged-in user matches the ID in the param
        if (req.user.id !== id) {
            return res.status(403).json({ message: "Unauthorized to update this user." })
        }

        const { name, phone, email, role } = req.body
        updateFields = {}

        if (name) updateFields.name = name
        if (phone) updateFields.phone = phone
        if (email) updateFields.email = email
        if (role) updateFields.role = role

        // if (!name || !phone || !email) {
        //     return res.status(400).json({ message: "All fields are required." })
        // }

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
            details: { targetUserId: id, updates: Object.keys(updateFields) }
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
    try {
        const { phone } = req.body;
        if (!phone) return res.status(400).json({ message: 'Phone number is required' });

        const user = await User.findOne({ phone });
        if (!user) return res.status(404).json({ message: 'User with this phone number not found' });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

        await User.findByIdAndUpdate(user._id, { otp, otpExpires });

        await sendSMS(user.phone, `Your Zantara password reset code is: ${otp}. Valid for 10 minutes.`);

        // Also send as in-app notification (security fallback)
        await notificationService.sendInApp(user._id, {
            title: 'Password Reset OTP',
            message: `Your password reset code is: ${otp}. Valid for 10 minutes.`,
            type: 'security'
        });

        res.json({ success: true, message: 'OTP sent successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error initiating password reset', error: error.message });
    }
}

const verifyResetOTP = async (req, res) => {
    try {
        const { phone, otp } = req.body;
        if (!phone || !otp) return res.status(400).json({ message: 'Phone and OTP are required' });

        const user = await User.findOne({ phone }).select('+otp +otpExpires');
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (user.otp !== otp || user.otpExpires < Date.now()) {
            return res.status(400).json({ message: 'Invalid or expired OTP' });
        }

        // Clear OTP and return a reset token
        await User.findByIdAndUpdate(user._id, { otp: null, otpExpires: null });
        
        const token = generateToken(user, '15m');
        res.json({ success: true, token, message: 'OTP verified' });
    } catch (error) {
        res.status(500).json({ message: 'Error verifying OTP', error: error.message });
    }
}

const resetPassword = async (req, res) => {
    try {
        const { password } = req.body;
        const decoded = jwt.verify(req.params.token, process.env.JWT_SECRET);
        
        const user = await User.findById(decoded.id).select('+password +passwordHistory');
        if (!user) return res.status(404).json({ message: 'User not found' });

        // Check against current and history
        if (user.password) {
            const isMatch = await bcrypt.compare(password, user.password);
            if (isMatch) return res.status(400).json({ message: "New password cannot be your current password." });
        }

        if (user.passwordHistory) {
            for (const oldHash of user.passwordHistory) {
                const isMatch = await bcrypt.compare(password, oldHash);
                if (isMatch) return res.status(400).json({ message: "You cannot reuse any of your last 5 passwords." });
            }
        }

        // Update history
        let newHistory = user.passwordHistory || [];
        if (user.password) {
            newHistory.unshift(user.password);
            if (newHistory.length > 5) newHistory = newHistory.slice(0, 5);
        }

        const hashed = await bcrypt.hash(password, 12);
        user.password = hashed;
        user.passwordHistory = newHistory;
        await user.save();

        res.json({ success: true, message: 'Password reset successful' });
 
        // Notify User
        await notificationService.sendInApp(user._id, {
            title: 'Password Restored',
            message: 'Your Zantara account password has been successfully reset.',
            type: 'security'
        });
    } catch (err) {
        res.status(400).json({ message: 'Invalid or expired reset session' });
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

        await sendSMS(user.phone, `Your Zantara verification code is: ${otp}. Valid for 10 minutes.`);

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
        const { newPassword } = req.body;
        const userId = req.user.id;

        if (!newPassword) {
            return res.status(400).json({ message: "New password is required." });
        }

        // Fetch user with password and history
        const user = await User.findById(userId).select('+password +passwordHistory');
        if (!user) return res.status(404).json({ message: "User not found." });

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
        user.password = hashed;
        user.passwordHistory = newHistory;
        await user.save();

        await ActivityLog.create({ 
            userId, 
            action: 'CHANGE_PASSWORD', 
            ipAddress: req.ip, 
            device: req.headers['user-agent'] 
        });

        res.json({ success: true, message: "Password updated successfully." });
 
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

        const user = await User.findById(req.user.id).select('+otp');
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (user.otp !== otp || user.otpExpires < Date.now()) {
            return res.status(400).json({ message: 'Invalid or expired OTP' });
        }

        await User.findByIdAndUpdate(user._id, {
            isPhoneVerified: true,
            otp: null,
            otpExpires: null,
            status: true // Auto-verify account status on phone success
        });

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
        await sendEmail(user.email, 'Your Zantara Verification Code', html);

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
        if (!pushToken) {
            return res.status(400).json({ success: false, message: 'Push token is required' });
        }
        await User.findByIdAndUpdate(req.user.id, { pushToken });
        res.json({ success: true, message: 'Push token saved' });
    } catch (error) {
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