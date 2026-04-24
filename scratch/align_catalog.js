const mongoose = require('mongoose');
const ServiceType = require('../models/ServiceType');
const ServiceCategory = require('../models/ServiceCategory');
require('dotenv').config();

async function alignCatalog() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        // 1. Ensure "VTU Services" Category exists
        let vtuCategory = await ServiceCategory.findOne({ slug: 'vtu-services' });
        if (!vtuCategory) {
            vtuCategory = await ServiceCategory.create({
                name: 'VTU Services',
                slug: 'vtu-services',
                description: 'Core utility and telecom services'
            });
            console.log('Created VTU Services category');
        }

        const expectedTypes = [
            { name: 'Data Bundle', slug: 'data' },
            { name: 'Airtime', slug: 'airtime' },
            { name: 'Cable TV', slug: 'tv' },
            { name: 'Electricity Bill', slug: 'electricity' },
            { name: 'Education PIN', slug: 'pin' }
        ];

        for (const type of expectedTypes) {
            // Check if it exists with the correct slug
            let doc = await ServiceType.findOne({ slug: type.slug });
            
            if (!doc) {
                // Check if it exists with an "old" slug (like data-bundle)
                if (type.slug === 'data') {
                    doc = await ServiceType.findOne({ slug: 'data-bundle' });
                    if (doc) {
                        doc.slug = 'data';
                        await doc.save();
                        console.log(`Renamed 'data-bundle' to 'data'`);
                        continue;
                    }
                }

                // Create new if still not found
                await ServiceType.create({
                    name: type.name,
                    slug: type.slug,
                    categoryId: vtuCategory._id,
                    status: true
                });
                console.log(`Created Service Type: ${type.name} (${type.slug})`);
            } else {
                console.log(`Service Type exists: ${type.name} (${type.slug})`);
            }
        }

        console.log('Alignment complete.');
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

alignCatalog();
