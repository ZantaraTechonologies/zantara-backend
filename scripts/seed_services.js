const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const Service = require('../models/Service');

const initialServices = [
    // --- AIRTIME ---
    { name: 'MTN Airtime', code: 'MTN_AIRTIME', category: 'airtime', providerCode: 'airtime', price: 100, costPrice: 97, provider: 'VTPass' },
    { name: 'Airtel Airtime', code: 'AIRTEL_AIRTIME', category: 'airtime', providerCode: 'airtime', price: 100, costPrice: 97, provider: 'VTPass' },
    { name: 'GLO Airtime', code: 'GLO_AIRTIME', category: 'airtime', providerCode: 'airtime', price: 100, costPrice: 96, provider: 'VTPass' },
    { name: '9mobile Airtime', code: '9MOBILE_AIRTIME', category: 'airtime', providerCode: 'airtime', price: 100, costPrice: 95, provider: 'VTPass' },

    // --- DATA ---
    { name: 'MTN 1GB (SME)', code: 'MTN_DATA_1GB', category: 'data', providerCode: 'mtn-sme-1gb', price: 300, costPrice: 260, provider: 'VTPass' },
    { name: 'MTN 2GB (SME)', code: 'MTN_DATA_2GB', category: 'data', providerCode: 'mtn-sme-2gb', price: 600, costPrice: 520, provider: 'VTPass' },
    { name: 'MTN 5GB (SME)', code: 'MTN_DATA_5GB', category: 'data', providerCode: 'mtn-sme-5gb', price: 1500, costPrice: 1300, provider: 'VTPass' },
    
    { name: 'Airtel 1GB', code: 'AIRTEL_DATA_1GB', category: 'data', providerCode: 'airtel-1gb', price: 350, costPrice: 300, provider: 'VTPass' },
    { name: 'GLO 1.35GB', code: 'GLO_DATA_1.35GB', category: 'data', providerCode: 'glo-1350mb', price: 500, costPrice: 450, provider: 'VTPass' },
    
    // --- ELECTRICITY ---
    { name: 'IKEDC (Prepaid)', code: 'IKEDC_PREPAID', category: 'electricity', providerCode: 'ikeja-electric', price: 1000, costPrice: 1000, provider: 'VTPass' },
    { name: 'EKEDC (Prepaid)', code: 'EKEDC_PREPAID', category: 'electricity', providerCode: 'eko-electric', price: 1000, costPrice: 1000, provider: 'VTPass' },

    // --- TV ---
    { name: 'DSTV Padi', code: 'DSTV_PADI', category: 'tv', providerCode: 'dstv-padi', price: 2950, costPrice: 2950, provider: 'VTPass' },
    { name: 'GOTV Jolli', code: 'GOTV_JOLLI', category: 'tv', providerCode: 'gotv-jolli', price: 3950, costPrice: 3950, provider: 'VTPass' }
];

async function seed() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to DB...');
        
        // Only seed if empty to prevent duplicates
        const count = await Service.countDocuments();
        if (count > 0) {
            console.log('Services already exist. Skipping seed.');
        } else {
            await Service.insertMany(initialServices);
            console.log(`Successfully seeded ${initialServices.length} services!`);
        }
        
    } catch (error) {
        console.error('Seed failed:', error);
    } finally {
        process.exit(0);
    }
}

seed();
