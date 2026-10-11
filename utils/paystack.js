// utils/paystack.js
const axios = require('axios');
require('dotenv').config();

const CLIENT_BASE_URL =
    (process.env.CLIENT_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');

async function getPaystackConfig() {
    // Lazy loading avoids introducing a startup module cycle through controllers.
    const paymentGatewayService = require('../services/paymentGateway.service');
    const gateway = await paymentGatewayService.getGateway('paystack');
    if (!gateway || gateway.status !== 'active' || gateway.adapterType !== 'paystack' || !gateway.secretKey) {
        const error = new Error('Database-managed Paystack gateway is unavailable');
        error.code = 'PAYSTACK_CONFIGURATION_UNAVAILABLE';
        throw error;
    }
    return {
        baseUrl: (gateway.baseUrl || 'https://api.paystack.co').replace(/\/$/, ''),
        secretKey: gateway.secretKey
    };
}

async function requestConfig() {
    const { baseUrl, secretKey } = await getPaystackConfig();
    return {
        baseUrl,
        config: {
            headers: {
                Authorization: `Bearer ${secretKey}`,
                'Content-Type': 'application/json',
            },
            timeout: 20000,
        }
    };
}

async function initializePayment(
    email,
    amount,
    metadata = {},
    reference,
    channels = ['card', 'ussd', 'bank_transfer']
) {
    if (!email) throw new Error('initializePayment: email is required');
    const kobo = Math.round(Number(amount) * 100);
    if (!kobo || kobo < 1) throw new Error('initializePayment: invalid amount');

    const body = {
        email,
        amount: kobo,
        metadata,
        ...(reference ? { reference } : {}),  // MUST match your DB row
        ...(channels ? { channels } : {}),
        callback_url: metadata?.callback_url || `${CLIENT_BASE_URL}/paystack/return`, // Allow override
    };

    try {
        const { baseUrl, config } = await requestConfig();
        const { data } = await axios.post(
            `${baseUrl}/transaction/initialize`,
            body,
            config
        );

        if (!data?.status) {
            throw new Error(data?.message || 'Paystack init failed');
        }

        // Optional: concise debug
        console.log('Paystack init:', {
            status: data.status,
            message: data.message,
            reference: data?.data?.reference,
        });

        return data; // { status, message, data: { authorization_url, access_code, reference } }
    } catch (err) {
        // Normalize Axios errors
        const msg =
            err?.response?.data?.message ||
            err?.message ||
            'Unknown Paystack init error';
        throw new Error(msg);
    }
}

async function getPaystackBalance() {
    try {
        const { baseUrl, config } = await requestConfig();
        const { data } = await axios.get(`${baseUrl}/balance`, config);
        
        if (data?.status && Array.isArray(data.data)) {
            // Paystack returns an array of balances for different currencies
            const ngnBalance = data.data.find(b => b.currency === 'NGN');
            return {
                success: true,
                balance: ngnBalance ? ngnBalance.balance / 100 : 0, // Convert Kobo to Naira
                currency: 'NGN'
            };
        }
        return { success: false, balance: 0, message: data?.message || 'Failed to fetch balance' };
    } catch (err) {
        return {
            success: false,
            balance: 0,
            message: err?.response?.data?.message || err.message || 'Paystack balance error'
        };
    }
}

async function createTransferRecipient(name, accountNumber, bankCode) {
    const body = {
        type: "nuban",
        name: name,
        account_number: accountNumber,
        bank_code: bankCode,
        currency: "NGN"
    };

    try {
        const { baseUrl, config } = await requestConfig();
        const { data } = await axios.post(`${baseUrl}/transferrecipient`, body, config);
        if (!data?.status) throw new Error(data?.message || 'Failed to create transfer recipient');
        return data.data.recipient_code;
    } catch (err) {
        throw new Error(err?.response?.data?.message || err.message);
    }
}

async function initiateTransfer(amount, recipientCode, reference, reason = "Withdrawal from Zantara") {
    const body = {
        source: "balance",
        amount: Math.round(Number(amount) * 100), // Kobo
        recipient: recipientCode,
        reference: reference,
        reason: reason
    };

    try {
        const { baseUrl, config } = await requestConfig();
        const { data } = await axios.post(`${baseUrl}/transfer`, body, config);
        if (!data?.status) throw new Error(data?.message || 'Transfer failed');
        return data;
    } catch (err) {
        throw new Error(err?.response?.data?.message || err.message);
    }
}

async function getBanks() {
    try {
        const { baseUrl, config } = await requestConfig();
        const { data } = await axios.get(`${baseUrl}/bank?country=nigeria`, config);
        if (data?.status) {
            return data.data; // Array of banks
        }
        throw new Error(data?.message || 'Failed to fetch banks');
    } catch (err) {
        throw new Error(err?.response?.data?.message || err.message);
    }
}

async function resolveAccount(accountNumber, bankCode) {
    try {
        const { baseUrl, config } = await requestConfig();
        const { data } = await axios.get(`${baseUrl}/bank/resolve`, {
            params: { account_number: accountNumber, bank_code: bankCode },
            ...config
        });
        if (data?.status) {
            return data.data; // { account_number, account_name, bank_id }
        }
        throw new Error(data?.message || 'Failed to resolve account');
    } catch (err) {
        throw new Error(err?.response?.data?.message || err.message);
    }
}

module.exports = { 
    initializePayment, 
    getPaystackBalance, 
    createTransferRecipient, 
    initiateTransfer,
    getBanks,
    resolveAccount
};
