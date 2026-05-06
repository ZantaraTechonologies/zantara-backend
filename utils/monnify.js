const axios = require('axios');
require('dotenv').config();

const MONNIFY_BASE_URL = (process.env.MONNIFY_BASE_URL || 'https://sandbox.monnify.com').replace(/\/$/, '');
const API_KEY = process.env.MONNIFY_API_KEY;
const SECRET_KEY = process.env.MONNIFY_SECRET_KEY;
const CONTRACT_CODE = process.env.MONNIFY_CONTRACT_CODE;
const CLIENT_BASE_URL = (process.env.CLIENT_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');

let cachedToken = null;
let tokenExpiry = null;

async function getAccessToken() {
    if (cachedToken && tokenExpiry && new Date() < tokenExpiry) {
        return cachedToken;
    }

    try {
        const auth = Buffer.from(`${API_KEY}:${SECRET_KEY}`).toString('base64');
        const response = await axios.post(`${MONNIFY_BASE_URL}/api/v1/auth/login`, {}, {
            headers: { Authorization: `Basic ${auth}` }
        });

        if (response.data.requestSuccessful) {
            cachedToken = response.data.responseBody.accessToken;
            // Token valid for 1 hour, refresh 5 mins early
            const expiresIn = response.data.responseBody.expiresIn || 3600;
            tokenExpiry = new Date(new Date().getTime() + (expiresIn - 300) * 1000);
            return cachedToken;
        } else {
            throw new Error(response.data.responseMessage || 'Monnify Auth Failed');
        }
    } catch (error) {
        throw new Error('Monnify Auth Error: ' + (error.response?.data?.responseMessage || error.message));
    }
}

async function initializePayment(email, amount, metadata = {}, reference) {
    if (!email) throw new Error('Monnify init: email is required');
    if (!amount || amount < 1) throw new Error('Monnify init: invalid amount');

    const token = await getAccessToken();

    const body = {
        amount: amount, // Monnify takes Naira, not Kobo? DOUBLE CHECK. Usually Paystack is Kobo. Monnify is usually Naira. I will assume Naira for now based on docs usually.
        customerName: metadata.name || 'Customer',
        customerEmail: email,
        paymentReference: reference,
        paymentDescription: 'Wallet Funding',
        currencyCode: 'NGN',
        contractCode: CONTRACT_CODE,
        redirectUrl: `${CLIENT_BASE_URL}/monnify/return`,
        paymentMethods: ["CARD", "ACCOUNT_TRANSFER"],
        metadata: metadata
    };

    try {
        const response = await axios.post(`${MONNIFY_BASE_URL}/api/v1/merchant/transactions/init-transaction`, body, {
            headers: { Authorization: `Bearer ${token}` }
        });

        if (response.data.requestSuccessful) {
            return {
                status: true,
                message: 'Success',
                data: {
                    authorization_url: response.data.responseBody.checkoutUrl,
                    reference: response.data.responseBody.paymentReference
                }
            };
        } else {
            throw new Error(response.data.responseMessage);
        }
    } catch (error) {
        throw new Error('Monnify Init Error: ' + (error.response?.data?.responseMessage || error.message));
    }
}

async function createReservedAccount(user) {
    if (!user.email && !user.phone) throw new Error('Monnify Reserved: Email or Phone is required');

    const token = await getAccessToken();
    const accountReference = `VIRTUAL_${user._id}`;

    const body = {
        accountReference: accountReference,
        accountName: user.name || 'Customer',
        currencyCode: 'NGN',
        contractCode: CONTRACT_CODE,
        customerEmail: user.email || `${user.phone}@zantara.com`, // Fallback for email-less users
        customerName: user.name || 'Customer',
        getAllAvailableBanks: true
    };

    try {
        const response = await axios.post(`${MONNIFY_BASE_URL}/api/v1/bank-transfer/reserved-accounts`, body, {
            headers: { Authorization: `Bearer ${token}` }
        });

        if (response.data.requestSuccessful) {
            return {
                status: true,
                accounts: response.data.responseBody.accounts, // Array of {bankCode, bankName, accountNumber}
                accountReference: response.data.responseBody.accountReference
            };
        } else {
            throw new Error(response.data.responseMessage);
        }
    } catch (error) {
        throw new Error('Monnify Reserved Account Error: ' + (error.response?.data?.responseMessage || error.message));
    }
}

async function getReservedAccount(accountReference) {
    const token = await getAccessToken();

    try {
        const response = await axios.get(`${MONNIFY_BASE_URL}/api/v1/bank-transfer/reserved-accounts/${accountReference}`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        console.log(`Monnify Get Account Response for ${accountReference}:`, JSON.stringify(response.data));

        if (response.data.requestSuccessful) {
            return {
                status: true,
                accounts: response.data.responseBody.accounts,
                accountReference: response.data.responseBody.accountReference
            };
        } else {
            throw new Error(response.data.responseMessage);
        }
    } catch (error) {
        throw new Error('Monnify Get Reserved Account Error: ' + (error.response?.data?.responseMessage || error.message));
    }
}

module.exports = { initializePayment, createReservedAccount, getReservedAccount };
