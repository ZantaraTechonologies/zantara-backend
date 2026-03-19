const express = require('express');
const router = express.Router();
const businessController = require('../controllers/businessController');
const expenseController = require('../controllers/expenseController');
const settlementController = require('../controllers/settlementController');
const { verifyJWT, checkRoles } = require('../middlewares/auth');

// All business routes require admin/superAdmin access
router.use(verifyJWT, checkRoles('admin', 'superAdmin'));

router.get('/overview', businessController.getOverview);
router.get('/wallet', businessController.getBusinessWallet);
router.get('/cost-ledger', businessController.getCostLedger);
router.get('/cash-flow', businessController.getCashFlow);
router.get('/refunds-losses', businessController.getRefundsLosses);

router.get('/expenses', expenseController.getExpenses);
router.post('/expenses', expenseController.createExpense);

router.get('/settlements', settlementController.getSettlements);
router.post('/settlements', settlementController.createSettlement);

module.exports = router;
