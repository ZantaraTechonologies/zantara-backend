'use strict';

const router = require('express').Router();
const { verifyJWT } = require('../middlewares/auth');
const { getStatus } = require('../controllers/onboardingController');

router.get('/status', verifyJWT, getStatus);

module.exports = router;
