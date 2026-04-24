const mongoose = require('mongoose');
const ServiceIdentity = require('../models/ServiceIdentity');
require('dotenv').config();

async function fixIdentitySlugs() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
        
        const identities = await ServiceIdentity.find();
        for (const i of identities) {
            if (!i.slug) {
                // Generate slug from internalCode if possible, or name
                const base = i.internalCode || i.name;
                i.slug = base.toLowerCase().replace(/ /g, '-').replace(/[^a-z0-9-]/g, '');
                
                // Ensure uniqueness (crude way for now)
                let suffix = 1;
                const originalSlug = i.slug;
                while (await ServiceIdentity.findOne({ slug: i.slug, _id: { $ne: i._id } })) {
                    i.slug = `${originalSlug}-${suffix++}`;
                }
                
                await i.save();
                console.log(`Updated Identity ${i.name} with slug ${i.slug}`);
            }
        }

        console.log('Identity slugs fixed.');
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

fixIdentitySlugs();
