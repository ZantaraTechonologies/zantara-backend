const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Setting = require('./models/Setting');

dotenv.config();

const seedSettings = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        const defaults = [
            { key: 'referral_enabled', value: true },
            { key: 'referral_percentage', value: 2 }, // 2%
            { key: 'agent_discount_percentage', value: 5 }, // 5%
            { key: 'monnify_enabled', value: true },
            { key: 'flutterwave_enabled', value: true },
            { key: 'airtime_enabled', value: true },
            { key: 'data_enabled', value: true }
        ];

        for (const setting of defaults) {
            const exists = await Setting.findOne({ key: setting.key });
            if (!exists) {
                await Setting.create(setting);
                console.log(`Created setting: ${setting.key}`);
            } else {
                console.log(`Setting exists: ${setting.key}`);
            }
        }

        console.log('Settings seeding complete');
        process.exit(0);
    } catch (err) {
        console.error('Seeding error:', err);
        process.exit(1);
    }
};

seedSettings();
