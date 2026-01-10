const axios = require('axios');
require('dotenv').config();

const FLUTTERWAVE_BASE_URL = (process.env.FLUTTERWAVE_BASE_URL || 'https://api.flutterwave.com/v3').replace(/\/$/, '');
const SECRET_KEY = process.env.FLUTTERWAVE_SECRET_KEY;
const CLIENT_BASE_URL = (process.env.CLIENT_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');

async function initializePayment(email, amount, metadata = {}, reference) {
    if (!email) throw new Error('Flutterwave init: email is required');
    if (!amount || amount < 1) throw new Error('Flutterwave init: invalid amount');

    const config = {
        headers: {
            Authorization: `Bearer ${SECRET_KEY}`,
            'Content-Type': 'application/json',
        }
    };

    const body = {
        tx_ref: reference,
        amount: amount,
        currency: 'NGN',
        redirect_url: `${CLIENT_BASE_URL}/flutterwave/return`,
        customer: {
            email: email,
            name: metadata.name || 'Customer'
        },
        meta: metadata,
        customizations: {
            title: "Wallet Funding",
            description: "Payment for wallet funding"
        }
    };

    try {
        const response = await axios.post(`${FLUTTERWAVE_BASE_URL}/payments`, body, config);

        if (response.data.status === 'success') {
            return {
                status: true,
                message: 'Success',
                data: {
                    authorization_url: response.data.data.link,
                    reference: reference
                }
            };
        } else {
            throw new Error(response.data.message || 'Flutterwave Init Failed');
        }
    } catch (error) {
        throw new Error('Flutterwave Init Error: ' + (error.response?.data?.message || error.message));
    }
}

module.exports = { initializePayment };
