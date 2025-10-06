const axios = require('axios')
require('dotenv').config()



const initializePayment = async (email, amount, metadata = {}, reference, channels = ['card', 'ussd', 'bank_transfer']) => {
    const config = {
        headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
            'Content-Type': 'application/json'
        }
    }

    const body = {
        email,
        amount: Math.round(Number(amount) * 100),   // kobo
        metadata,
        ...(reference ? { reference } : {}),
        ...(channels ? { channels } : {})
    }

    console.log(body)

    const res = await axios.post(`${process.env.PAYSTACK_BASE_URL}/transaction/initialize`, body, config)
    console.log("Initialization")
    console.log(res)
    return res.data
}

module.exports = { initializePayment }






