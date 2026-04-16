const User = require('../models/User');
const { sendResponse } = require('../utils/response');
const { getBanks, resolveAccount: resolvePaystackAccount } = require('../utils/paystack');

let bankCache = {
    data: null,
    lastFetched: 0
};

const CACHE_DURATION = 1000 * 60 * 60 * 24; // 24 hours

const POPULAR_BANK_CODES = [
    '044', // Access Bank
    '011', // First Bank of Nigeria
    '058', // Guaranty Trust Bank
    '033', // United Bank for Africa
    '057', // Zenith Bank
    '221', // Stanbic IBTC Bank
    '070', // Fidelity Bank
    '232', // Sterling Bank
    '035', // Wema Bank
    '050', // EcoBank
    '032', // Union Bank
    '214', // FCMB
    '076', // Polaris Bank
    '082', // Keystone Bank
    '50211', // Kuda Bank
    '999992', // OPay
    '999991', // PalmPay
    '50515', // Moniepoint MFB
    '100004'  // OPay Digital Services
];

const linkAccount = async (req, res) => {
    try {
        const { bankName, bankCode, accountName, accountNumber } = req.body;
        if (!bankName || !accountName || !accountNumber) {
            return sendResponse(res, { status: 400, success: false, message: 'Missing required bank details' });
        }

        const user = await User.findById(req.user.id);
        if (!user) return sendResponse(res, { status: 404, success: false, message: 'User not found' });

        // Add to linkedAccounts
        user.linkedAccounts.push({
            bankName,
            bankCode,
            accountName,
            accountNumber,
            isDefault: user.linkedAccounts.length === 0
        });

        await user.save();
        return sendResponse(res, { message: 'Bank account linked successfully', data: user.linkedAccounts });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

const getLinkedAccounts = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        return sendResponse(res, { data: user.linkedAccounts || [] });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

const unlinkAccount = async (req, res) => {
    try {
        const { accountId } = req.params;
        const user = await User.findById(req.user.id);
        
        user.linkedAccounts = user.linkedAccounts.filter(acc => acc._id.toString() !== accountId);
        await user.save();
        
        return sendResponse(res, { message: 'Bank account removed successfully', data: user.linkedAccounts });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

const getBanksList = async (req, res) => {
    try {
        const now = Date.now();
        if (!bankCache.data || (now - bankCache.lastFetched > CACHE_DURATION)) {
            const banks = await getBanks();
            bankCache.data = banks;
            bankCache.lastFetched = now;
        }

        const type = req.query.type || 'popular';
        let filteredBanks = bankCache.data;

        if (type === 'popular') {
            filteredBanks = bankCache.data.filter(bank => POPULAR_BANK_CODES.includes(bank.code));
            // Sort by popularity/name? Access, First, GTB...
            filteredBanks.sort((a, b) => {
                const aIdx = POPULAR_BANK_CODES.indexOf(a.code);
                const bIdx = POPULAR_BANK_CODES.indexOf(b.code);
                return aIdx - bIdx;
            });
        }

        return sendResponse(res, { data: filteredBanks });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

const resolveAccount = async (req, res) => {
    try {
        const { accountNumber, bankCode } = req.query;

        if (!accountNumber || !bankCode) {
            return sendResponse(res, { status: 400, success: false, message: 'Account number and bank code are required' });
        }

        const data = await resolvePaystackAccount(accountNumber, bankCode);

        if (data && data.account_name) {
            return sendResponse(res, { 
                data: { account_name: data.account_name } 
            });
        } else {
            return sendResponse(res, { status: 400, success: false, message: 'Could not resolve account' });
        }
    } catch (err) {
        const message = err.message;
        const status = err.response?.status || 400; // Paystack errors are often 4xx
        return sendResponse(res, { status, success: false, message });
    }
};

module.exports = { linkAccount, getLinkedAccounts, unlinkAccount, resolveAccount, getBanks: getBanksList };
