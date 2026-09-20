const express = require('express');
const router = express.Router();
const { verifyJWT, checkRoles } = require('../middlewares/auth');
const requireLegalCompliance = require('../middlewares/requireLegalCompliance');
const requireTransactionPin = require('../middlewares/requireTransactionPin');
const { pinLimiter } = require('../middlewares/limiter');
const {
    getInvestmentSummary,
    buyShares,
    requestShareExit,
    reinvestDividends,
    redeemToMainWallet,
    requestDividendWithdrawal,
    getDividendHistory,
    getShareholderOverview,
    getAllShareholders,
    getPendingShareExits,
    processShareExit,
    getPendingDividendWithdrawals,
    processDividendWithdrawal,
    getInvestmentSettings,
    updateInvestmentSettings,
    triggerManualDividendPayout
} = require('../controllers/investmentController');

// ─── User Routes (any logged-in user) ───────────────────────
router.get('/summary',  verifyJWT, getInvestmentSummary);
router.get('/history',  verifyJWT, getDividendHistory);
router.post('/buy',     verifyJWT, requireLegalCompliance, pinLimiter, requireTransactionPin, buyShares);
router.post('/exit',    verifyJWT, requireLegalCompliance, pinLimiter, requireTransactionPin, requestShareExit);
router.post('/reinvest',verifyJWT, requireLegalCompliance, pinLimiter, requireTransactionPin, reinvestDividends);
router.post('/redeem',  verifyJWT, requireLegalCompliance, pinLimiter, requireTransactionPin, redeemToMainWallet);
router.post('/withdraw',verifyJWT, requireLegalCompliance, pinLimiter, requireTransactionPin, requestDividendWithdrawal);

// ─── Admin Routes (superAdmin only) ─────────────────────────
router.get('/admin/overview',     verifyJWT, checkRoles('superAdmin'), getShareholderOverview);
router.get('/admin/shareholders', verifyJWT, checkRoles('superAdmin'), getAllShareholders);
router.get('/admin/exits',        verifyJWT, checkRoles('superAdmin'), getPendingShareExits);
router.put('/admin/exits/:id',    verifyJWT, checkRoles('superAdmin'), processShareExit);
router.get('/admin/withdrawals',  verifyJWT, checkRoles('superAdmin'), getPendingDividendWithdrawals);
router.put('/admin/withdrawals/:id', verifyJWT, checkRoles('superAdmin'), processDividendWithdrawal);
router.get('/admin/settings',     verifyJWT, checkRoles('superAdmin'), getInvestmentSettings);
router.put('/admin/settings',     verifyJWT, checkRoles('superAdmin'), updateInvestmentSettings);
router.post('/admin/payout/trigger', verifyJWT, checkRoles('superAdmin'), triggerManualDividendPayout);

module.exports = router;
