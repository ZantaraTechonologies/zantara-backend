const mongoose = require('mongoose');
const ServiceIdentity = require('../models/ServiceIdentity');
const ServiceType = require('../models/ServiceType'); // Required for population
require('dotenv').config();

async function alignProviderCodes() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
        
        const identities = await ServiceIdentity.find().populate('typeId');
        
        for (const identity of identities) {
            let pCode = '';
            const name = identity.name.toLowerCase();
            const typeSlug = identity.typeId?.slug || '';
            
            if (name.includes('mtn')) pCode = 'mtn';
            else if (name.includes('glo')) pCode = 'glo';
            else if (name.includes('airtel')) pCode = 'airtel';
            else if (name.includes('9mobile')) pCode = '9mobile';
            else if (name.includes('dstv')) pCode = 'dstv';
            else if (name.includes('gotv')) pCode = 'gotv';
            else if (name.includes('startimes')) pCode = 'startimes';
            else if (name.includes('showmax')) pCode = 'showmax';
            
            if (typeSlug === 'data' && pCode && !pCode.endsWith('-data')) {
                pCode += '-data';
            }
            
            if (pCode) {
                identity.providerCode = pCode;
                await identity.save();
                console.log(`Updated ${identity.name}: providerCode = ${pCode}`);
            }
        }

        console.log('Alignment complete');
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

alignProviderCodes();
