const mongoose = require('mongoose');
const Brand = require('./models/Brand');
const Service = require('./models/Service');
require('dotenv').config();

const restoreAssociations = async () => {
    try {
        console.log('--- Phase B: Restoring Brand-Type Associations ---');
        await mongoose.connect(process.env.MONGO_URI);

        const brands = await Brand.find();
        
        for (const brand of brands) {
            // Find all services linked to this brand to see which types it supports
            const services = await Service.find({ brandId: brand._id });
            const typeIds = [...new Set(services.map(s => s.typeId).filter(id => id).map(id => id.toString()))];
            
            if (typeIds.length > 0) {
                console.log(`Updating "${brand.name}": Found ${typeIds.length} associated types via Service records.`);
                await Brand.findByIdAndUpdate(brand._id, {
                    $set: { typeIds: typeIds.map(id => new mongoose.Types.ObjectId(id)) }
                });
            } else {
                console.log(`Brand "${brand.name}" has no linked services yet.`);
            }
        }

        console.log('--- Restoration Complete ---');
        process.exit(0);
    } catch (err) {
        console.error('Restoration failed:', err);
        process.exit(1);
    }
};

restoreAssociations();
