// utils/paystack.js
const axios = require('axios');
require('dotenv').config();

const PAYSTACK_BASE_URL =
    (process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co').replace(/\/$/, '');
const CLIENT_BASE_URL =
    (process.env.CLIENT_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');

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

    const config = {
        headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
            'Content-Type': 'application/json',
        },
        timeout: 20000,
    };

    const body = {
        email,
        amount: kobo,
        metadata,
        ...(reference ? { reference } : {}),  // MUST match your DB row
        ...(channels ? { channels } : {}),
        callback_url: metadata?.callback_url || `${CLIENT_BASE_URL}/paystack/return`, // Allow override
    };

    try {
        const { data } = await axios.post(
            `${PAYSTACK_BASE_URL}/transaction/initialize`,
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
    const config = {
        headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
            'Content-Type': 'application/json',
        },
    };

    try {
        const { data } = await axios.get(`${PAYSTACK_BASE_URL}/balance`, config);
        
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

module.exports = { initializePayment, getPaystackBalance };
