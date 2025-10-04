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
    logout
} = require('../controllers/authController')
const { verifyJWT } = require('../middlewares/auth')
const { loginLimiter } = require('../middlewares/limiter')
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

module.exports = router;
