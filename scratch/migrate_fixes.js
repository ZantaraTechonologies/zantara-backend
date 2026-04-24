const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/vtu-app';

async function migrate() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('Connected to MongoDB');

        // 1. Update ServiceType slug 'exam-pin' to 'pin'
        const ServiceType = mongoose.model('ServiceType', new mongoose.Schema({ slug: String }));
        const pinType = await ServiceType.findOneAndUpdate(
            { slug: 'exam-pin' },
            { slug: 'pin' },
            { new: true }
        );
        
        if (pinType) {
            console.log('Updated ServiceType slug from "exam-pin" to "pin"');
        } else {
            console.log('ServiceType with slug "exam-pin" not found. Checking for "pin"...');
            const alreadyPin = await ServiceType.findOne({ slug: 'pin' });
            if (alreadyPin) console.log('ServiceType already has slug "pin"');
            else console.log('ERROR: ServiceType "exam-pin" not found and "pin" not found.');
        }

        // 2. Update JAMB PricingRule markup
        const PricingRule = mongoose.model('PricingRule', new mongoose.Schema({
            targetType: String,
            targetId: mongoose.Schema.Types.ObjectId,
            userRole: String,
            markupValue: Number
        }));

        const jambIdentityId = '6627f426c4ed80b7f7b0899a';
        const ruleUpdate = await PricingRule.findOneAndUpdate(
            { 
                targetType: 'identity', 
                targetId: new mongoose.Types.ObjectId(jambIdentityId),
                userRole: 'retail'
            },
            { markupValue: 100 },
            { new: true }
        );

        if (ruleUpdate) {
            console.log(`Updated PricingRule for JAMB retail markup to ${ruleUpdate.markupValue}`);
        } else {
            console.log('PricingRule for JAMB retail not found. Checking if it exists with another ID or role...');
            // Fallback search by targetType and role just in case
            const anyJambRule = await PricingRule.findOne({ targetType: 'identity', userRole: 'retail' });
            if (anyJambRule) {
                 console.log(`Found a retail rule for identity ${anyJambRule.targetId}. Updating it.`);
                 anyJambRule.markupValue = 100;
                 await anyJambRule.save();
                 console.log('Updated markup to 100');
            } else {
                console.log('ERROR: No retail pricing rule found for any identity.');
            }
        }

        await mongoose.disconnect();
        console.log('Done.');
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
}

migrate();
