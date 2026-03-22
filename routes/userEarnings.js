const express = require('express');
const router = express.Router();
const { verifyJWT } = require('../middlewares/auth');
const { 
    getUserEarningsSummary, 
    getUserEarningsHistory 
} = require('../controllers/analyticsController');

// All routes here are protected and specific to the logged-in user
router.use(verifyJWT);

router.get('/summary', getUserEarningsSummary);
router.get('/history', getUserEarningsHistory);

module.exports = router;
