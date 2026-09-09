const assert = require('assert');
const { encryptSecret, decryptSecret, isEncrypted } = require('../utils/crypto');
const { serializeProvider, sanitizeMetadata, isForbiddenMetadataKey } = require('../utils/providerSerializer');

async function runTests() {
    console.log('====================================================');
    console.log('     ZANTARA PROVIDER CREDENTIAL SECURITY TESTS     ');
    console.log('====================================================\n');

    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        try {
            fn();
            console.log(`✅ [PASS] ${name}`);
            passed++;
        } catch (err) {
            console.error(`❌ [FAIL] ${name}`);
            console.error(`   Error: ${err.message}\n`);
            failed++;
        }
    }

    // ----------------------------------------------------
    // TEST 1: Encryption & Decryption roundtrip
    // ----------------------------------------------------
    test('1. Encryption & Decryption produces exact original value', () => {
        const rawSecret = 'sample_api_secret_key_123456789';
        const encrypted = encryptSecret(rawSecret);

        assert.strictEqual(isEncrypted(encrypted), true, 'Ciphertext should start with enc:v1:');
        assert.notStrictEqual(encrypted, rawSecret, 'Ciphertext must not equal plaintext');

        const decrypted = decryptSecret(encrypted);
        assert.strictEqual(decrypted, rawSecret, 'Decrypted value must match original');
    });

    // ----------------------------------------------------
    // TEST 2: Prevent double encryption
    // ----------------------------------------------------
    test('2. Double-encryption is prevented', () => {
        const rawSecret = 'sample_api_key_998877';
        const encryptedOnce = encryptSecret(rawSecret);
        const encryptedTwice = encryptSecret(encryptedOnce);

        assert.strictEqual(encryptedOnce, encryptedTwice, 'Re-encrypting an encrypted string should return original ciphertext');
    });

    // ----------------------------------------------------
    // TEST 3: Legacy Plaintext Backward Compatibility
    // ----------------------------------------------------
    test('3. Legacy plaintext credentials decrypted gracefully without breaking', () => {
        const legacyPlaintext = 'legacy_unencrypted_secret_0000';
        assert.strictEqual(isEncrypted(legacyPlaintext), false, 'Legacy string should not be marked as encrypted');

        const decrypted = decryptSecret(legacyPlaintext);
        assert.strictEqual(decrypted, legacyPlaintext, 'Legacy plaintext should be returned unchanged by decryptSecret');
    });

    // ----------------------------------------------------
    // TEST 4: Serializer Response Masking & Secret Stripping
    // ----------------------------------------------------
    test('4. Provider Serializer strips raw secrets and returns configured indicators', () => {
        const rawKey = 'live_sk_9876543210';
        const encryptedKey = encryptSecret(rawKey);
        const encryptedSecret = encryptSecret('super_secret_password_777');

        const mockDoc = {
            _id: '65f0123456789abc',
            name: 'MELE Data',
            adapterType: 'universal',
            baseUrl: 'https://api.meledata.ng/v1',
            apiKey: encryptedKey,
            secretKey: encryptedSecret,
            publicKey: 'pub_key_123',
            status: 'active',
            balance: 5000,
            metadata: {
                authHeaderName: 'Authorization',
                authHeaderValue: 'Bearer {{apiKey}}'
            }
        };

        const serialized = serializeProvider(mockDoc);

        assert.strictEqual(serialized.secretKey, undefined, 'secretKey must be completely omitted from response');
        assert.notStrictEqual(serialized.apiKey, encryptedKey, 'Raw/encrypted apiKey must not be present');
        assert.strictEqual(serialized.apiKeyConfigured, true, 'apiKeyConfigured must be true');
        assert.strictEqual(serialized.secretKeyConfigured, true, 'secretKeyConfigured must be true');
        assert.strictEqual(serialized.apiKeyMasked, '••••3210', 'apiKeyMasked must show last 4 chars of decrypted original');
        assert.strictEqual(serialized.metadata.authHeaderValue, 'Bearer {{apiKey}}', 'Template in metadata allowed');
    });

    // ----------------------------------------------------
    // TEST 5: Metadata Forbidden Secret Key Protection
    // ----------------------------------------------------
    test('5. Metadata strips raw secret keys while retaining template strings', () => {
        assert.strictEqual(isForbiddenMetadataKey('password'), true);
        assert.strictEqual(isForbiddenMetadataKey('secretKey'), true);
        assert.strictEqual(isForbiddenMetadataKey('apiKey'), true);
        assert.strictEqual(isForbiddenMetadataKey('purchaseUrl'), false);

        const dirtyMetadata = {
            purchaseUrl: '/buy-data',
            password: 'raw_unencrypted_password_123',
            authHeaderValue: 'Bearer {{apiKey}}'
        };

        const sanitized = sanitizeMetadata(dirtyMetadata);

        assert.strictEqual(sanitized.purchaseUrl, '/buy-data');
        assert.strictEqual(sanitized.authHeaderValue, 'Bearer {{apiKey}}');
        assert.strictEqual(sanitized.password, undefined, 'Direct raw password key must be stripped from metadata');
    });

    // ----------------------------------------------------
    // SUMMARY
    // ----------------------------------------------------
    console.log('\n----------------------------------------------------');
    console.log(`Test Execution Finished: ${passed} PASSED, ${failed} FAILED.`);
    console.log('----------------------------------------------------');

    if (failed > 0) {
        process.exit(1);
    }
}

runTests();
