const mongoose = require('mongoose');
require('dotenv').config();
const ServiceType = require('../models/ServiceType');

async function seedAliases() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to database.');

        const mappings = [
            { slug: 'airtime-recharge', aliases: ['airtime', 'airtime_recharge'] },
            { slug: 'data-plans', aliases: ['data', 'mobile-data', 'data_plans'] },
            { slug: 'cable-tv', aliases: ['tv', 'cable', 'cable_tv'] },
            { slug: 'electricity-bills', aliases: ['electricity', 'power', 'utility'] },
            { slug: 'exam-pins', aliases: ['pin', 'pins', 'education'] }
        ];

        for (const m of mappings) {
            // Find by slug (since we saw 'airtime-recharge' in the DB earlier)
            const result = await ServiceType.updateOne(
                { slug: m.slug },
                { $addToSet: { aliases: { $each: m.aliases } } }
            );
            
            if (result.matchedCount > 0) {
                console.log(`Updated aliases for ${m.slug}: ${m.aliases.join(', ')}`);
            } else {
                // If the slug is different, try to find by a partial match or ignore
                console.log(`Could not find service type with slug: ${m.slug}`);
            }
        }

        console.log('Alias seeding complete.');
        process.exit(0);
    } catch (err) {
        console.error('Seeding failed:', err);
        process.exit(1);
    }
}

seedAliases();
