/**
 * Fix: Create agent PricingRules for all service types that don't have one yet.
 * Uses the same markupValue (10%) as the existing agent data rule.
 * Run: node scratch/fix_agent_pricing_rules.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const AGENT_MARKUP_VALUE = 10; // 10% markup for agents (matches existing data rule)
const AGENT_MARKUP_TYPE = 'percent';

// Service types that need agent rules
const SERVICE_TYPES = [
    { id: '69ece2ad4ca5eee5262c807c', name: 'Airtime Recharge' },
    { id: '69ed928c7e33802e9ad30485', name: 'Data Bundle' },         // already has one — will skip
    { id: '69ee363d39b30f92090ba73c', name: 'TV Subscription' },
    { id: '69eeea806d9f58e907bd6625', name: 'Electricity Bills Payment' },
    { id: '69eefdc46d9f58e907bd7314', name: 'Exam PIN' },
];

async function main() {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected\n');

    const PricingRule = require('../models/PricingRule');

    for (const st of SERVICE_TYPES) {
        // Check if agent rule already exists for this service type
        const existing = await PricingRule.findOne({
            targetType: 'service_type',
            targetId: new mongoose.Types.ObjectId(st.id),
            userRole: 'agent',
        });

        if (existing) {
            console.log(`[SKIP] ${st.name} — agent rule already exists (markupValue=${existing.markupValue}%)`);
            continue;
        }

        // Create the agent rule
        const rule = await PricingRule.create({
            targetType: 'service_type',
            targetId: new mongoose.Types.ObjectId(st.id),
            userRole: 'agent',
            markupType: AGENT_MARKUP_TYPE,
            markupValue: AGENT_MARKUP_VALUE,
            priority: 0,
            status: true,
        });

        console.log(`[CREATED] ${st.name} — agent rule created (${AGENT_MARKUP_VALUE}% markup) [${rule._id}]`);
    }

    console.log('\nDone. All missing agent rules have been created.');
    await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
