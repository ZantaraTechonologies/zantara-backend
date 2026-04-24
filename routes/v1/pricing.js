const express = require('express');
const router = express.Router();
const pricingController = require('../../controllers/v1/pricingController');
const { verifyJWT } = require('../../middlewares/auth');

/**
 * Pricing Preview Routes (v1)
 */
router.post('/calculate', verifyJWT, pricingController.calculatePrice);

module.exports = router;
