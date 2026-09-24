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
    getReferralStats,
    changePassword,
    verifyResetOTP,
    savePushToken
} = require('../controllers/authController')
const { setPin, changePin, verifyPin } = require('../controllers/pinController')
const { verifyJWT } = require('../middlewares/auth')
const {
    loginLimiter,
    pinLimiter,
    resetRequestLimiter,
    resetVerifyLimiter,
    resetCompleteLimiter,
    phoneOtpRequestLimiter,
    phoneOtpVerifyLimiter,
    emailOtpRequestLimiter,
    emailOtpVerifyLimiter
} = require('../middlewares/limiter')
const multer = require('multer')

const registrationUpload = multer({
    limits: {
        fields: 32,
        files: 0,
        parts: 32,
        fieldNameSize: 100,
        fieldSize: 64 * 1024,
        fieldNestingDepth: 4,
        fieldArrayIndexLimit: 16
    }
})

const parseRegistrationForm = (req, res, next) => {
    registrationUpload.none()(req, res, (err) => {
        if (!err || err instanceof multer.MulterError) return next(err)

        const multipartError = new Error('Invalid multipart request')
        multipartError.code = 'INVALID_MULTIPART'
        multipartError.status = 400
        return next(multipartError)
    })
}

router.post('/register', parseRegistrationForm, register)
router.post('/login', loginLimiter, login)
router.get('/me', verifyJWT, profile)
router.put('/update-profile', verifyJWT, (req, res) => {
    req.params.id = req.user.id;
    updateUser(req, res);
});
router.put('/users/:id', verifyJWT, updateUser)
// Legacy link endpoint remains fail-closed. The active in-repo verification
// workflow uses /email/send-otp and /email/verify-otp; no link issuer exists.
router.get('/verify-email/:token', verifyEmail)
router.post('/forgot-password', resetRequestLimiter, forgotPassword)
router.post('/verify-reset-otp', resetVerifyLimiter, verifyResetOTP)
router.put('/reset-password/:token', resetCompleteLimiter, resetPassword)
router.post('/change-password', verifyJWT, changePassword)
router.post('/logout', logout)
router.post('/set-pin', verifyJWT, pinLimiter, setPin)
router.post('/change-pin', verifyJWT, pinLimiter, changePin)
router.post('/verify-pin', verifyJWT, pinLimiter, verifyPin)

router.post('/send-otp', verifyJWT, phoneOtpRequestLimiter, sendOTP)
router.post('/verify-otp', verifyJWT, phoneOtpVerifyLimiter, verifyOTP)
router.post('/email/send-otp', verifyJWT, emailOtpRequestLimiter, sendEmailOTP)
router.post('/email/verify-otp', verifyJWT, emailOtpVerifyLimiter, verifyEmailOTP)
router.get('/referrals', verifyJWT, getReferralStats)
router.post('/push-token', verifyJWT, savePushToken)

module.exports = router;
