require('dotenv').config();
const mongoose = require('mongoose');
const PaymentGateway = require('../models/PaymentGateway');
const { encryptSecret, isEncrypted } = require('../utils/crypto');

async function seedPaymentGateways() {
    console.log('====================================================');
    console.log('       ZANTARA PAYMENT GATEWAY SEED / MIGRATION     ');
    console.log('====================================================\n');

    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
        console.error('ERROR: MONGO_URI is not set in environment.');
        process.exit(1);
    }

    try {
        await mongoose.connect(mongoUri);
        console.log('Connected to MongoDB successfully.\n');

        // 1. Paystack Configuration (Primary)
        const paystackSecret = process.env.PAYSTACK_SECRET_KEY;
        const paystackPublic = process.env.PAYSTACK_PUBLIC_KEY || '';
        const paystackBaseUrl = process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co';

        let paystack = await PaymentGateway.findOne({ code: 'paystack' });
        if (!paystack) {
            console.log('[+] Creating initial Paystack gateway record...');
            paystack = new PaymentGateway({
                name: 'Paystack',
                code: 'paystack',
                adapterType: 'paystack',
                status: paystackSecret ? 'active' : 'inactive',
                environment: paystackSecret && paystackSecret.startsWith('sk_live_') ? 'live' : 'test',
                isDefault: true,
                priority: 1,
                publicKey: paystackPublic,
                secretKey: paystackSecret ? (isEncrypted(paystackSecret) ? paystackSecret : encryptSecret(paystackSecret)) : '',
                webhookSecret: paystackSecret ? (isEncrypted(paystackSecret) ? paystackSecret : encryptSecret(paystackSecret)) : '',
                baseUrl: paystackBaseUrl,
                supportedChannels: ['card', 'bank_transfer', 'ussd'],
                metadata: {}
            });
            await paystack.save();
            console.log('    -> Paystack seeded (status: active, default: true)');
        } else {
            console.log('[*] Paystack gateway record already exists.');
            // Only update keys if existing record has blank keys and env has keys
            let changed = false;
            if (!paystack.secretKey && paystackSecret) {
                paystack.secretKey = isEncrypted(paystackSecret) ? paystackSecret : encryptSecret(paystackSecret);
                paystack.status = 'active';
                changed = true;
            }
            if (!paystack.publicKey && paystackPublic) {
                paystack.publicKey = paystackPublic;
                changed = true;
            }
            if (changed) {
                await paystack.save();
                console.log('    -> Paystack credentials updated from environment');
            }
        }

        // 2. Monnify Configuration (Secondary)
        const monnifyApiKey = process.env.MONNIFY_API_KEY || '';
        const monnifySecretKey = process.env.MONNIFY_SECRET_KEY || '';
        const monnifyContractCode = process.env.MONNIFY_CONTRACT_CODE || '';
        const monnifyBaseUrl = process.env.MONNIFY_BASE_URL || 'https://sandbox.monnify.com';

        let monnify = await PaymentGateway.findOne({ code: 'monnify' });
        if (!monnify) {
            console.log('[+] Creating initial Monnify gateway record...');
            monnify = new PaymentGateway({
                name: 'Monnify',
                code: 'monnify',
                adapterType: 'monnify',
                status: (monnifyApiKey && monnifySecretKey) ? 'active' : 'inactive',
                environment: monnifyBaseUrl.includes('sandbox') ? 'test' : 'live',
                isDefault: false,
                priority: 2,
                publicKey: monnifyApiKey,
                secretKey: monnifySecretKey ? (isEncrypted(monnifySecretKey) ? monnifySecretKey : encryptSecret(monnifySecretKey)) : '',
                webhookSecret: monnifySecretKey ? (isEncrypted(monnifySecretKey) ? monnifySecretKey : encryptSecret(monnifySecretKey)) : '',
                baseUrl: monnifyBaseUrl,
                supportedChannels: ['bank_transfer', 'virtual_account', 'card'],
                metadata: {
                    contractCode: monnifyContractCode
                }
            });
            await monnify.save();
            console.log(`    -> Monnify seeded (status: ${monnify.status}, default: false)`);
        } else {
            console.log('[*] Monnify gateway record already exists.');
        }

        // 3. Flutterwave Configuration (Tertiary)
        const flwSecret = process.env.FLUTTERWAVE_SECRET_KEY || '';
        const flwPublic = process.env.FLUTTERWAVE_PUBLIC_KEY || '';
        const flwHash = process.env.FLUTTERWAVE_HASH || '';
        const flwBaseUrl = process.env.FLUTTERWAVE_BASE_URL || 'https://api.flutterwave.com/v3';

        let flutterwave = await PaymentGateway.findOne({ code: 'flutterwave' });
        if (!flutterwave) {
            console.log('[+] Creating initial Flutterwave gateway record...');
            flutterwave = new PaymentGateway({
                name: 'Flutterwave',
                code: 'flutterwave',
                adapterType: 'flutterwave',
                status: flwSecret ? 'active' : 'inactive',
                environment: flwSecret.startsWith('FLWSECK_TEST') ? 'test' : 'live',
                isDefault: false,
                priority: 3,
                publicKey: flwPublic,
                secretKey: flwSecret ? (isEncrypted(flwSecret) ? flwSecret : encryptSecret(flwSecret)) : '',
                webhookSecret: flwHash ? (isEncrypted(flwHash) ? flwHash : encryptSecret(flwHash)) : '',
                baseUrl: flwBaseUrl,
                supportedChannels: ['card', 'bank_transfer', 'ussd'],
                metadata: {}
            });
            await flutterwave.save();
            console.log(`    -> Flutterwave seeded (status: ${flutterwave.status}, default: false)`);
        } else {
            console.log('[*] Flutterwave gateway record already exists.');
        }

        console.log('\nSeed / Migration completed successfully.');
        process.exit(0);
    } catch (err) {
        console.error('Seed error:', err.message);
        process.exit(1);
    }
}

if (require.main === module) {
    seedPaymentGateways();
}

module.exports = seedPaymentGateways;
