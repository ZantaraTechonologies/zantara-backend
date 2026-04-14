const axios = require('axios');
require('dotenv').config();

const API_URL = 'http://localhost:8000/api/bank-accounts/resolve';
// Note: This needs a valid JWT as it's protected by verifyJWT.
// and a valid account number/bank code.

async function testResolve() {
    try {
        console.log('Testing Bank Resolution Endpoint...');
        // We'd need a token here to test properly.
        // For now, let's just check if the server is running and the route responds.
        const res = await axios.get(API_URL, {
            params: { accountNumber: '0123456789', bankCode: '058' }
        });
        console.log('Response:', res.data);
    } catch (err) {
        console.log('Error Status:', err.response?.status);
        console.log('Error Message:', err.response?.data?.message || err.message);
    }
}

testResolve();
