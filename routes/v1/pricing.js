const express = require('express');
const router = express.Router();
const pricingController = require('../../controllers/v1/pricingController');
const { verifyJWT } = require('../../middlewares/auth');
const requireOnboardingComplete = require('../../middlewares/requireOnboardingComplete');

/**
 * Pricing Preview Routes (v1)
 */
router.post('/calculate', verifyJWT, requireOnboardingComplete, pricingController.calculatePrice);

module.exports = router;
