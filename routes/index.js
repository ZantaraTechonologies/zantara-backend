const router = require('express').Router()
const userModel = require('../models/User')

router.get('/', (req, res) => {
    res.json({ message: 'VTU API Ready' })
});

router.get('/health-debug', (req, res) => {
    res.json({
        ok: true,
        secretSet: !!process.env.JWT_SECRET,
        secretLength: process.env.JWT_SECRET?.length,
        nodeEnv: process.env.NODE_ENV,
        mongoSet: !!process.env.MONGO_URI
    });
});

module.exports = router
