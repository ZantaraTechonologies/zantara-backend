require('dotenv').config();
const mongoose = require('mongoose');
const Provider = require('../models/Provider');
const { encryptSecret, isEncrypted } = require('../utils/crypto');

async function runMigration() {
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
        console.error('[Migration Error] MONGO_URI is missing in environment variables.');
        process.exit(1);
    }

    try {
        console.log('[Migration] Connecting to MongoDB...');
        await mongoose.connect(mongoUri);
        console.log('[Migration] Connected successfully.');

        const providers = await Provider.find();
        console.log(`[Migration] Found ${providers.length} provider document(s) to inspect.`);

        let migratedCount = 0;
        let skippedCount = 0;

        for (const provider of providers) {
            let modified = false;

            if (provider.apiKey && !isEncrypted(provider.apiKey)) {
                provider.apiKey = encryptSecret(provider.apiKey);
                modified = true;
            }

            if (provider.secretKey && !isEncrypted(provider.secretKey)) {
                provider.secretKey = encryptSecret(provider.secretKey);
                modified = true;
            }

            if (modified) {
                await provider.save();
                migratedCount++;
                console.log(`[Migration] Encrypted credentials for Provider ID: ${provider._id} (Name: ${provider.name})`);
            } else {
                skippedCount++;
            }
        }

        console.log(`[Migration Complete] Summary: ${migratedCount} migrated, ${skippedCount} skipped (already encrypted or no keys).`);
    } catch (err) {
        console.error('[Migration Failed] Error:', err.message);
    } finally {
        await mongoose.disconnect();
        console.log('[Migration] Database disconnected.');
    }
}

runMigration();
