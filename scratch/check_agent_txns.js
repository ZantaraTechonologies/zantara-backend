/**
 * Check the 2 latest agent transactions in detail
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
    await mongoose.connect(process.env.MONGO_URI);
    const Transaction = require('../models/Transaction');

    const AGENT_ID = '69f61db634733d1471f48aa7';

    const txns = await Transaction.find({
        userId: new mongoose.Types.ObjectId(AGENT_ID),
        status: 'success',
        type: { $nin: ['referral_bonus', 'referral_redeem', 'wallet_funding', 'share_purchase'] }
    }).sort({ createdAt: -1 }).limit(4);

    txns.forEach((t, i) => {
        console.log(`\n=== Transaction ${i + 1} ===`);
        console.log('type:', t.type);
        console.log('amount:', t.amount);
        console.log('userRole:', t.userRole);
        console.log('createdAt:', t.createdAt);
        console.log('pricingSnapshot:', JSON.stringify(t.pricingSnapshot, null, 2));
    });

    await mongoose.disconnect();
}
main().catch(console.error);
