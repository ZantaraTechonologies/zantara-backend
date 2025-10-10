const express = require('express')
const router = express.Router()
const { profile } = require('../controllers/authController')
const { verifyJWT, checkRoles } = require('../middlewares/auth')

router.get('/me', verifyJWT, checkRoles('admin', 'superAdmin'), profile)

module.exports = router