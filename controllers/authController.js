const User = require('../models/User')
const Wallet = require('../models/Wallet')
const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const { generateToken, sendToken, cookieOpts, clearAuthCookie } = require('../utils/authUtils')
const { sendEmail } = require('../utils/mailer')
const { sendSMS } = require('../utils/sms')
const ActivityLog = require('../models/ActivityLog')

const register = async (req, res) => {
    let { name, email, phone, password, referrerCode, role } = req.body
    
    // Normalize email
    if (email) email = email.trim().toLowerCase();
    if (phone) phone = phone.trim();

    // Email is now optional, Phone is REQUIRED
    if (!name || !phone || !password) {
        return res.status(400).json({ message: "Name, phone and password are required" });
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
        if (referrerCode) {
            const referrer = await User.findOne({ myReferralCode: referrerCode.trim() });
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
            referrerCode: referrerCode ? referrerCode.trim() : undefined,
            referredBy,
            myReferralCode,
            roles
        };

        if (email && email.trim()) {
            userData.email = email.trim().toLowerCase();
        }

        const user = await User.create(userData);

        await Wallet.create({ userId: user._id })

        await ActivityLog.create({ 
            userId: user._id, 
            action: 'REGISTER', 
            ipAddress: req.ip, 
            device: req.headers['user-agent'] 
        })

        console.log(`Registration successful for user: ${phone}`);
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
        })

        if (!user) return res.status(400).json({ message: 'Invalid credentials' })

        const match = await bcrypt.compare(password, user.password)
        if (!match) return res.status(400).json({ message: 'Invalid credentials' })

        await ActivityLog.create({ userId: user._id, action: 'LOGIN', ipAddress: req.ip, device: req.headers['user-agent'] })

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
    const email = (req.body.email || "").trim().toLowerCase();
    const user = await User.findOne({ email })
    if (!user) return res.status(404).json({ message: 'Email not found' })

    const token = generateToken(user, '15m')
    const resetLink = `${process.env.CLIENT_URL}/reset-password/${token}`
    await sendEmail(user.email, 'Reset your password', `<a href="${resetLink}">Reset Password</a>`)
    res.json({ message: 'Password reset email sent' })
}

const resetPassword = async (req, res) => {
    try {
        const decoded = jwt.verify(req.params.token, process.env.JWT_SECRET)
        const hashed = await bcrypt.hash(req.body.password, 12)
        await User.findByIdAndUpdate(decoded.id, { password: hashed })
        res.json({ message: 'Password reset successful' })
    } catch (err) {
        res.status(400).json({ message: 'Invalid or expired token' })
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

        res.json({ success: true, message: 'OTP sent successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error sending OTP', error: error.message });
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
    getReferralStats
}