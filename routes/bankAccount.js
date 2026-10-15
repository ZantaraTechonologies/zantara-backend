const express = require('express');
const router = express.Router();
const { linkAccount, getLinkedAccounts, unlinkAccount, resolveAccount, getBanks } = require('../controllers/bankAccountController');
const { verifyJWT } = require('../middlewares/auth');
const requireOnboardingComplete = require('../middlewares/requireOnboardingComplete');

router.use(verifyJWT);
router.use(requireOnboardingComplete);

router.get('/resolve', resolveAccount);
router.get('/banks', getBanks);
router.post('/', linkAccount);
router.get('/', getLinkedAccounts);
router.delete('/:accountId', unlinkAccount);

module.exports = router;
