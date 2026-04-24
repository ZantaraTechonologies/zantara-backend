const mongoose = require('mongoose');
require('dotenv').config();

require('../models/ServiceCategory');
require('../models/ServiceType');
require('../models/Brand');
const Service = require('../models/Service');
const ProviderOffer = require('../models/ProviderOffer');
const PricingRule = require('../models/PricingRule');

async function validate() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('--- VALIDATION REPORT ---');

        // 1. Service linking
        const totalServices = await Service.countDocuments({});
        const linkedServices = await Service.countDocuments({ categoryId: { $ne: null } });
        console.log(`Services: ${linkedServices}/${totalServices} linked to hierarchy.`);

        // 2. Brand Quality
        const Brand = mongoose.model('Brand');
        const brands = await Brand.find({}).populate('typeId');
        console.log(`Brands created: ${brands.length}`);
        
        const otherBrands = brands.filter(b => b.name === 'Other');
        console.log(`"Other" Brands: ${otherBrands.length}`);
        for (const b of otherBrands) {
           const sample = await Service.findOne({ brandId: b._id });
           console.log(`   - Other Brand for Type ${b.typeId.name}: Example Service "${sample?.name}"`);
        }

        // 3. ProviderOffer Count
        const offerCount = await ProviderOffer.countDocuments({});
        console.log(`ProviderOffers created: ${offerCount}`);

        // 4. Check for orphaned offers
        const orphanedOffers = await ProviderOffer.countDocuments({ serviceId: { $nin: await Service.distinct('_id') } });
        console.log(`Orphaned ProviderOffers: ${orphanedOffers}`);

        // 5. Fulfillment Mode Distribution
        const syncCount = await Service.countDocuments({ fulfillmentMode: 'sync' });
        const asyncCount = await Service.countDocuments({ fulfillmentMode: 'async' });
        const manualCount = await Service.countDocuments({ fulfillmentMode: 'manual' });
        console.log(`Fulfillment Modes: Sync(${syncCount}), Async(${asyncCount}), Manual(${manualCount})`);

        console.log('--- END OF REPORT ---');
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

validate();
