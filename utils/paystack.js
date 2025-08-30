const axios = require('axios')
require('dotenv').config()

const initializePayment = async (email, amount, metadata = {}) => {
    try {
        const config = {
            headers: {
                Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
            }
        }
    
        const body = {
            email,
            amount: amount * 100, // Paystack accepts kobo
            metadata
        }
    
        const res = await axios.post(`${process.env.PAYSTACK_BASE_URL}/transaction/initialize`, body, config)
        return res.data
    } catch (error) {
        console.error('Paystack Error:', error.response?.data || error.message);
        throw error;
    }
}

module.exports = { initializePayment }