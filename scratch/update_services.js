const mongoose = require('mongoose');
const Service = require('../models/Service');
require('dotenv').config();

async function updateServices() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        const updates = [
            { code: 'JAMB_UTME_WITH_MOCK', providerCode: 'utme-mock' },
            { code: 'JAMB_UTME_NO_MOCK', providerCode: 'utme-no-mock' },
            { code: 'WAEC_REG_PRIVATE_CANDIDATE', providerCode: 'waec-registraion' },
            { code: 'WAEC_RESULT_WASSCE', providerCode: 'waecdirect' }
        ];

        for (const up of updates) {
            const res = await Service.updateOne(
                { code: up.code },
                { $set: { providerCode: up.providerCode } }
            );
            console.log(`Updated ${up.code}: ${res.modifiedCount} document(s)`);
        }

        await mongoose.disconnect();
    } catch (err) {
        console.error('Error:', err);
    }
}

updateServices();
