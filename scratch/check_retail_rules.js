const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/vtu-app';

async function check() {
    try {
        await mongoose.connect(MONGO_URI);
        const PricingRule = mongoose.model('PricingRule', new mongoose.Schema({
            targetType: String,
            targetId: mongoose.Schema.Types.ObjectId,
            userRole: String,
            markupValue: Number,
            markupType: String
        }));

        const rules = await PricingRule.find({ targetType: 'identity', userRole: 'retail' });
        console.log('Retail Identity Rules:');
        console.log(JSON.stringify(rules, null, 2));

        const ServiceIdentity = mongoose.model('ServiceIdentity', new mongoose.Schema({ name: String, slug: String }));
        const jamb = await ServiceIdentity.findOne({ slug: 'jamb' });
        console.log('JAMB Identity:', jamb);

        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
    }
}
check();
