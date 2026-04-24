const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/vtu-app';

async function check() {
    try {
        await mongoose.connect(MONGO_URI);
        
        const ServiceIdentity = mongoose.model('ServiceIdentity', new mongoose.Schema({}, { strict: false }));
        const identities = await ServiceIdentity.find({}, { name: 1, slug: 1, internalCode: 1 });
        console.log('--- Identities ---');
        identities.forEach(i => console.log(`Name: ${i.get('name')}, Slug: ${i.get('slug')}, ID: ${i._id}`));

        const PricingRule = mongoose.model('PricingRule', new mongoose.Schema({}, { strict: false }));
        const rules = await PricingRule.find({});
        console.log('\n--- Pricing Rules ---');
        rules.forEach(r => {
            console.log(`Target: ${r.get('targetType')}, TargetId: ${r.get('targetId')}, Role: ${r.get('userRole')}, Markup: ${r.get('markupValue')}`);
        });

        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
    }
}
check();
