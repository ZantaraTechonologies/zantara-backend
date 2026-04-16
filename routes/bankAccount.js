const express = require('express');
const router = express.Router();
const { linkAccount, getLinkedAccounts, unlinkAccount, resolveAccount } = require('../controllers/bankAccountController');
const { verifyJWT } = require('../middlewares/auth');

router.use(verifyJWT);

router.get('/resolve', resolveAccount);
router.get('/banks', getBanks);
router.post('/', linkAccount);
router.get('/', getLinkedAccounts);
router.delete('/:accountId', unlinkAccount);

module.exports = router;
