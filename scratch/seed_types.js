const mongoose = require('mongoose');
const ServiceType = require('../models/ServiceType');
require('dotenv').config();

async function seedMissingTypes() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
        
        const ServiceCategory = require('../models/ServiceCategory');
        const vtuCat = await ServiceCategory.findOne({ slug: 'vtu-services' });
        if (!vtuCat) {
            console.error('VTU Services category not found. Please create it first.');
            return;
        }

        const typesToSeed = [
            { name: 'Electricity', slug: 'electricity', categoryId: vtuCat._id },
            { name: 'Exam PIN', slug: 'pin', categoryId: vtuCat._id }
        ];

        for (const t of typesToSeed) {
            const exists = await ServiceType.findOne({ slug: t.slug });
            if (!exists) {
                await ServiceType.create({ ...t, status: true });
                console.log(`Created ServiceType: ${t.name} (${t.slug})`);
            } else {
                console.log(`ServiceType already exists: ${t.name} (${t.slug})`);
            }
        }

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

seedMissingTypes();
