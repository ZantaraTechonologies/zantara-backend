const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/vtu-app';

async function check() {
    try {
        await mongoose.connect(MONGO_URI);
        
        const PricingRule = mongoose.model('PricingRule', new mongoose.Schema({}, { strict: false }));
        const rule = await PricingRule.findOne({ markupValue: 1600 });
        if (rule) {
            console.log('Found problematic rule:');
            console.log(JSON.stringify(rule, null, 2));
        } else {
            console.log('No rule with markupValue 1600 found.');
            // Try 1500?
            const rule2 = await PricingRule.findOne({ markupValue: 1500 });
            if (rule2) console.log('Found rule with 1500 markup:', rule2);
        }

        const ServiceType = mongoose.model('ServiceType', new mongoose.Schema({}, { strict: false }));
        const types = await ServiceType.find({});
        console.log('\n--- Service Types ---');
        types.forEach(t => console.log(`Name: ${t.get('name')}, Slug: ${t.get('slug')}, ID: ${t._id}`));

        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
    }
}
check();
