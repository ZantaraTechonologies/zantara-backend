const mongoose = require('mongoose');
const Service = require('./models/Service');
const ProviderOffer = require('./models/ProviderOffer');
require('dotenv').config();

const runPurge = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('--- Purging Legacy Noise ---');
        
        const noisyServices = await Service.find({ 
            $or: [
                { identityId: null }, 
                { identityId: { $exists: false } }
            ] 
        }).select('_id');
        
        const serviceIds = noisyServices.map(s => s._id);
        
        const deletedOffers = await ProviderOffer.deleteMany({ serviceId: { $in: serviceIds } });
        const deletedServices = await Service.deleteMany({ _id: { $in: serviceIds } });
        
        console.log(`Successfully purged ${deletedServices.deletedCount} services and ${deletedOffers.deletedCount} offers.`);
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

runPurge();
