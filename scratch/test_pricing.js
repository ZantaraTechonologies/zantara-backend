const axios = require('axios');

async function testPricing() {
    try {
        const res = await axios.post('http://localhost:8000/api/v1/pricing/calculate', {
            serviceCode: 'mtnairtime',
            amount: 500
        }, {
            headers: {
                'x-client-type': 'test'
            }
        });
        console.log('Response:', JSON.stringify(res.data, null, 2));
    } catch (err) {
        console.error('Error:', err.response?.data || err.message);
    }
}

testPricing();
