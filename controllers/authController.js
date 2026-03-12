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

// const register = async (req, res) => {
//     const { name, email, phone, password, referrerCode, role } = req.body

//     if (!name || !email || !phone || !password) {
//         return res.status(400).json({ message: "Name, email, phone and password are required" });
//     }

//     // const session = await mongoose.startSession()
//     // session.startTransaction()

//     try {
//         const phoneExists = await checkPhone(phone)
//         if (phoneExists) {
//             // await session.abortTransaction()
//             // session.endSession()
//             return res.status(409).json({ message: "Phone number already in use" })
//         }

//         const emailExists = await checkEmail(email)
//         if (emailExists) {
//             // await session.abortTransaction()
//             // session.endSession()
//             return res.status(409).json({ message: "Email address already in use" })
//         }

//         const myReferralCode = await generateUniqueReferralCode()

//         const hashed = await bcrypt.hash(password, 12)

//         const userData = {
//             name, email, phone, password: hashed, referrerCode, myReferralCode, role
//         }
//         if (role) userData.role = role


//         // const myReferralCode = phone
//         const user = await User.create(userData)


//         // Auto-create wallet with 0 balance
//         await Wallet.create({ userId: user._id })

//         // // Commit transaction
//         // await session.commitTransaction()
//         // session.endSession()

//         // Send verification link and token
//         // const verifyToken = generateToken(user, '1d')
//         // const verifyLink = `${process.env.CLIENT_URL}/verify-email/${verifyToken}`
//         // await sendEmail(email, 'Verify your email', `<a href="${verifyLink}">Verify</a>`)

//         sendToken(user, res)
//     } catch (error) {
//         // await session.abortTransaction()
//         // session.endSession()
//         res.status(500).json({ message: "Registration failed", error: error.message })
//     }
// }

const register = async (req, res) => {
    const { name, email, phone, password, referrerCode, role } = req.body

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

        const roles = role ? [role] : ['user'];

        const user = await User.create({
            name, 
            email: email || undefined, // Store as undefined if not provided for sparse index
            phone, 
            password: hashed, 
            referrerCode, 
            myReferralCode,
            roles 
        })

        await Wallet.create({ userId: user._id })

        await ActivityLog.create({ userId: user._id, action: 'REGISTER', ipAddress: req.ip, device: req.headers['user-agent'] })

        sendToken(user, res)
    } catch (error) {
        res.status(500).json({ message: "Registration failed", error: error.message })
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
    const { identifier, email, phone, password } = req.body // Support 'identifier' or specific fields

    const loginId = identifier || email || phone;

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
    const user = await User.findOne({ email: req.body.email })
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
    verifyOTP
}