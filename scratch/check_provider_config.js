const mongoose = require('mongoose');
const Provider = require('../models/Provider');
require('dotenv').config();

async function checkProvider() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
        
        const provider = await Provider.findOne({ name: /vtpass/i });
        if (!provider) {
            console.log('VTPass provider not found');
        } else {
            console.log('Provider Found:');
            console.log('Name:', provider.name);
            console.log('API Key:', provider.apiKey ? 'PRESENT' : 'MISSING');
            console.log('Public Key:', provider.publicKey ? 'PRESENT' : 'MISSING');
            console.log('Secret Key:', provider.secretKey ? 'PRESENT' : 'MISSING');
            console.log('Base URL:', provider.baseUrl);
            console.log('Adapter Type:', provider.adapterType);
            
            // Log lengths or first/last chars for debugging without exposing full keys if they are sensitive
            if (provider.apiKey) console.log('API Key length:', provider.apiKey.length);
            if (provider.publicKey) console.log('Public Key length:', provider.publicKey.length);
        }
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

checkProvider();
