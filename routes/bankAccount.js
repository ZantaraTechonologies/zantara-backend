const express = require('express');
const router = express.Router();
const { linkAccount, getLinkedAccounts, unlinkAccount } = require('../controllers/bankAccountController');
const { verifyJWT } = require('../middlewares/auth');

router.use(verifyJWT);

router.post('/', linkAccount);
router.get('/', getLinkedAccounts);
router.delete('/:accountId', unlinkAccount);

module.exports = router;
