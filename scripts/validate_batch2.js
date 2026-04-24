const mongoose = require('mongoose');
require('dotenv').config();

const Service = require('../models/Service');
const ProviderOffer = require('../models/ProviderOffer');
const PricingRule = require('../models/PricingRule');
const Provider = require('../models/Provider');
const pricingEngine = require('../services/pricing.service');
const procurementEngine = require('../services/procurement.service');

async function validate() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to DB.');

        const service = await Service.findOne({ code: 'MTN_DATA_1GB' });
        const provider = await Provider.findOne({ name: 'VTPass' });
        const user = { role: 'user', accountType: 'retail' };

        console.log('\n--- Scenario 1: Full Match (Service + Offer + Rule) ---');
        const rule1 = await PricingRule.create({
            targetType: 'service', targetId: service._id, userRole: 'all',
            markupType: 'fixed', markupValue: 20, status: true, priority: 1
        });
        const offer1 = await ProviderOffer.findOne({ serviceId: service._id, providerId: provider._id });
        
        const proc1 = await procurementEngine.selectBestOffer(service._id);
        const price1 = await pricingEngine.resolvePricing(user, service, proc1, 300);
        console.log('Result:', price1 ? 'MATCH' : 'FALLBACK', 'Price:', price1?.salePrice);
        await rule1.deleteOne();

        console.log('\n--- Scenario 2: Service + Offer but NO Rule ---');
        const price2 = await pricingEngine.resolvePricing(user, service, offer1, 300);
        console.log('Result:', price2 ? 'MATCH' : 'FALLBACK');

        console.log('\n--- Scenario 3: Service + Rule but NO Active Offer ---');
        await ProviderOffer.updateOne({ _id: offer1._id }, { status: false });
        const proc3 = await procurementEngine.selectBestOffer(service._id);
        console.log('Procurement Result:', proc3 ? 'OFFER_FOUND' : 'NO_OFFER');
        await ProviderOffer.updateOne({ _id: offer1._id }, { status: true });

        console.log('\n--- Scenario 4: Negative Profit Safety ---');
        const rule4 = await PricingRule.create({
            targetType: 'service', targetId: service._id, userRole: 'all',
            markupType: 'fixed', markupValue: -50, status: true, priority: 1
        });
        const price4 = await pricingEngine.resolvePricing(user, service, offer1, 300);
        console.log('Price Result:', price4.salePrice, 'Profit:', price4.profit);
        if (price4.profit <= 0) console.log('Safety Check Result: Abort would happen in purchase service.');
        await rule4.deleteOne();

        console.log('\n--- Scenario 5: Determinism Check (Tie Priority) ---');
        // Create another offer with same priority
        const provider2 = await Provider.create({ name: 'TestProvider', adapterType: 'universal', baseUrl: 'http://test', apiKey: 'test' });
        const offer2 = await ProviderOffer.create({
            serviceId: service._id, providerId: provider2._id, providerCode: 'test',
            costPrice: 250, priority: 1, status: true
        });
        
        const proc5a = await procurementEngine.selectBestOffer(service._id);
        const proc5b = await procurementEngine.selectBestOffer(service._id);
        console.log('Deterministic?', proc5a._id.toString() === proc5b._id.toString());
        
        await offer2.deleteOne();
        await provider2.deleteOne();

        console.log('\n--- Scenario 6: Role Layering (Agent vs User) ---');
        const ruleGlobal = await PricingRule.create({ targetType: 'global', userRole: 'all', markupType: 'fixed', markupValue: 10, status: true, priority: 1 });
        const ruleAgent = await PricingRule.create({ targetType: 'global', userRole: 'agent', markupType: 'fixed', markupValue: 5, status: true, priority: 1 });
        
        const priceUser = await pricingEngine.resolvePricing({ role: 'user' }, service, offer1, 300);
        const priceAgent = await pricingEngine.resolvePricing({ role: 'agent' }, service, offer1, 300);
        console.log('User Markup:', priceUser.markupValue, 'Agent Markup:', priceAgent.markupValue);
        
        await ruleGlobal.deleteOne();
        await ruleAgent.deleteOne();

        console.log('\n--- END OF VALIDATION ---');
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

validate();
