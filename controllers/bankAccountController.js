const User = require('../models/User');
const { sendResponse } = require('../utils/response');
const axios = require('axios');

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

const resolveAccount = async (req, res) => {
    try {
        const { accountNumber, bankCode } = req.query;

        if (!accountNumber || !bankCode) {
            return sendResponse(res, { status: 400, success: false, message: 'Account number and bank code are required' });
        }

        const response = await axios.get(`https://api.paystack.co/bank/resolve`, {
            params: { account_number: accountNumber, bank_code: bankCode },
            headers: {
                Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
            }
        });

        if (response.data.status) {
            return sendResponse(res, { 
                data: { account_name: response.data.data.account_name } 
            });
        } else {
            return sendResponse(res, { status: 400, success: false, message: 'Could not resolve account' });
        }
    } catch (err) {
        const message = err.response?.data?.message || err.message;
        const status = err.response?.status || 500;
        return sendResponse(res, { status, success: false, message });
    }
};

module.exports = { linkAccount, getLinkedAccounts, unlinkAccount, resolveAccount };
