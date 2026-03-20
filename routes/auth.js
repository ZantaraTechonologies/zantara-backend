const express = require('express')
const router = express.Router()
const {
    register,
    login,
    profile,
    updateUser,
    verifyEmail,
    forgotPassword,
    resetPassword,
    logout,
    sendOTP,
    verifyOTP,
    sendEmailOTP,
    verifyEmailOTP,
    getReferralStats
} = require('../controllers/authController')
const { setPin, changePin } = require('../controllers/pinController')
const { verifyJWT } = require('../middlewares/auth')
const { loginLimiter, pinLimiter } = require('../middlewares/limiter')
const multer = require('multer')

const upload = multer() // Multer for form-data without files

router.post('/register', upload.none(), register)
router.post('/login', loginLimiter, login)
router.get('/me', verifyJWT, profile)
router.put('/users/:id', verifyJWT, updateUser)
router.get('/verify-email/:token', verifyEmail)
router.post('/forgot-password', forgotPassword)
router.put('/reset-password/:token', resetPassword)
router.post('/logout', logout)
router.post('/set-pin', verifyJWT, pinLimiter, setPin)
router.post('/change-pin', verifyJWT, pinLimiter, changePin)

router.post('/send-otp', verifyJWT, sendOTP)
router.post('/verify-otp', verifyJWT, verifyOTP)
router.post('/email/send-otp', verifyJWT, sendEmailOTP)
router.post('/email/verify-otp', verifyJWT, verifyEmailOTP)
router.get('/referrals', verifyJWT, getReferralStats)

module.exports = router;
