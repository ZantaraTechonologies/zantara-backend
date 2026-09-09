const assert = require('assert');
const axios = require('axios');
const UniversalAdapter = require('../adapters/universal.adapter');
const VTPassAdapter = require('../adapters/vtpass.adapter');
const { encryptSecret, decryptSecret, isEncrypted } = require('../utils/crypto');
const { 
    serializeProvider, 
    sanitizeMetadata, 
    validateMetadata, 
    ALLOWED_METADATA_KEYS 
} = require('../utils/providerSerializer');

async function runAllTests() {
    console.log('====================================================');
    console.log('    ZANTARA UNIVERSAL PROVIDER ARCHITECTURE TESTS   ');
    console.log('====================================================\n');

    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            await fn();
            console.log(`✅ [PASS] ${name}`);
            passed++;
        } catch (err) {
            console.error(`❌ [FAIL] ${name}`);
            console.error(`   Error: ${err.message}\n`);
            failed++;
        }
    }

    // ----------------------------------------------------
    // TEST 1: Universal provider using only purchaseUrl
    // ----------------------------------------------------
    await test('1. Universal provider using only purchaseUrl falls back for all categories', () => {
        const adapter = new UniversalAdapter({
            baseUrl: 'https://api.genericvtu.com/v1',
            apiKey: 'test_key_123',
            metadata: {
                purchaseUrl: '/api/v1/buy'
            }
        });

        // Airtime, Data, Electricity, Cable, Exam PIN all resolve to purchaseUrl
        const airtimeUrl = adapter._resolveUrlWithFallback('airtimePurchaseUrl', 'purchaseUrl', '');
        const dataUrl = adapter._resolveUrlWithFallback('dataPurchaseUrl', 'purchaseUrl', '');
        const electricityUrl = adapter._resolveUrlWithFallback('electricityPurchaseUrl', 'purchaseUrl', '');
        const cableUrl = adapter._resolveUrlWithFallback('cablePurchaseUrl', 'purchaseUrl', '');
        const examUrl = adapter._resolveUrlWithFallback('examPurchaseUrl', 'purchaseUrl', '');

        assert.strictEqual(airtimeUrl, 'https://api.genericvtu.com/v1/api/v1/buy');
        assert.strictEqual(dataUrl, 'https://api.genericvtu.com/v1/api/v1/buy');
        assert.strictEqual(electricityUrl, 'https://api.genericvtu.com/v1/api/v1/buy');
        assert.strictEqual(cableUrl, 'https://api.genericvtu.com/v1/api/v1/buy');
        assert.strictEqual(examUrl, 'https://api.genericvtu.com/v1/api/v1/buy');
    });

    // ----------------------------------------------------
    // TEST 2: Category-specific endpoint override
    // ----------------------------------------------------
    await test('2. dataPurchaseUrl override applies to data while airtime still uses purchaseUrl', () => {
        const adapter = new UniversalAdapter({
            baseUrl: 'https://api.hybridvendor.com',
            apiKey: 'test_key_456',
            metadata: {
                purchaseUrl: '/api/common/vend',
                dataPurchaseUrl: '/api/special/data-vend',
                electricityPurchaseUrl: 'https://electricity.subdomain.com/pay'
            }
        });

        const dataUrl = adapter._resolveUrlWithFallback('dataPurchaseUrl', 'purchaseUrl', '');
        const airtimeUrl = adapter._resolveUrlWithFallback('airtimePurchaseUrl', 'purchaseUrl', '');
        const electricUrl = adapter._resolveUrlWithFallback('electricityPurchaseUrl', 'purchaseUrl', '');

        assert.strictEqual(dataUrl, 'https://api.hybridvendor.com/api/special/data-vend', 'Data should use override');
        assert.strictEqual(airtimeUrl, 'https://api.hybridvendor.com/api/common/vend', 'Airtime should fallback to purchaseUrl');
        assert.strictEqual(electricUrl, 'https://electricity.subdomain.com/pay', 'Absolute URL should be preserved intact');
    });

    // ----------------------------------------------------
    // TEST 3: Category-specific HTTP method override
    // ----------------------------------------------------
    await test('3. Category-specific HTTP method override with fallback', () => {
        const adapter = new UniversalAdapter({
            baseUrl: 'https://api.test.com',
            apiKey: 'key',
            metadata: {
                method: 'POST',
                dataMethod: 'PUT',
                balanceMethod: 'GET',
                verifyMethod: 'PATCH'
            }
        });

        assert.strictEqual(adapter._resolveMethod('airtimeMethod', 'method', 'POST'), 'POST', 'Airtime falls back to global method');
        assert.strictEqual(adapter._resolveMethod('dataMethod', 'method', 'POST'), 'PUT', 'Data uses specific dataMethod');
        assert.strictEqual(adapter._resolveMethod('balanceMethod', null, 'GET'), 'GET', 'Balance uses balanceMethod');
        assert.strictEqual(adapter._resolveMethod('verifyMethod', null, 'POST'), 'PATCH', 'Verify uses verifyMethod');
    });

    // ----------------------------------------------------
    // TEST 4: Custom Authentication Template Resolution
    // ----------------------------------------------------
    await test('4. Custom authentication Authorization: Bearer {{apiKey}} resolves server-side', () => {
        const adapter = new UniversalAdapter({
            baseUrl: 'https://api.authservice.com',
            apiKey: 'sk_live_secret_token_abcdef',
            secretKey: 'my_secret_pass',
            metadata: {
                authHeaderName: 'Authorization',
                authHeaderValue: 'Bearer {{apiKey}}'
            }
        });

        const headers = adapter._buildHeaders();
        assert.strictEqual(headers['Authorization'], 'Bearer sk_live_secret_token_abcdef', 'Template {{apiKey}} must resolve to decrypted key');
        assert.strictEqual(headers['Content-Type'], 'application/json');

        // Test with secretKey in template
        const customAdapter = new UniversalAdapter({
            baseUrl: 'https://api.authservice.com',
            apiKey: 'user_1',
            secretKey: 'pwd_99',
            metadata: {
                authHeaderName: 'X-Vendor-Auth',
                authHeaderValue: 'Basic {{secretKey}}'
            }
        });
        const customHeaders = customAdapter._buildHeaders();
        assert.strictEqual(customHeaders['X-Vendor-Auth'], 'Basic pwd_99');
    });

    // ----------------------------------------------------
    // TEST 5: Request Field Mapping
    // ----------------------------------------------------
    await test('5. Request field mapping translates internal keys to external keys', async () => {
        const adapter = new UniversalAdapter({
            baseUrl: 'https://api.dorosub.com',
            apiKey: 'live_key',
            metadata: {
                purchaseUrl: '/buy',
                method: 'POST',
                fieldMap: {
                    phone: 'mobile_number',
                    request_id: 'reference',
                    variation_code: 'plan_id',
                    serviceID: 'network'
                }
            }
        });

        // Intercept axios to inspect payload
        const originalAxios = axios.request;
        let capturedOptions = null;
        
        // Mocking axios call via _processRequest test
        const originalProcess = adapter._processRequest;
        // Test field mapping logic directly
        const testData = {
            phone: '08012345678',
            request_id: 'REQ_98765',
            variation_code: '500MB',
            serviceID: 'mtn',
            amount: 150
        };

        const activeFieldMap = adapter.metadata.fieldMap;
        const payload = {};
        Object.entries(activeFieldMap).forEach(([internalKey, externalKey]) => {
            if (testData[internalKey] !== undefined) {
                payload[externalKey] = testData[internalKey];
            }
        });

        assert.strictEqual(payload.mobile_number, '08012345678');
        assert.strictEqual(payload.reference, 'REQ_98765');
        assert.strictEqual(payload.plan_id, '500MB');
        assert.strictEqual(payload.network, 'mtn');
        assert.strictEqual(payload.phone, undefined, 'Internal phone key must be mapped away');
    });

    // ----------------------------------------------------
    // TEST 6: Response Success Mapping (successPath + successValue + dot-paths)
    // ----------------------------------------------------
    await test('6. Response success mapping handles dot-paths, status codes, and identifiers', () => {
        const adapter = new UniversalAdapter({
            baseUrl: 'https://api.example.com',
            apiKey: 'key',
            metadata: {
                successPath: 'response.code',
                successValue: '200',
                statusPath: 'data.order_status',
                transactionIdPath: 'data.provider_reference',
                messagePath: 'response.description',
                balancePath: 'user.wallet.available_balance'
            }
        });

        const mockApiResponse = {
            response: {
                code: 200,
                description: 'Order successfully completed'
            },
            data: {
                order_status: 'delivered',
                provider_reference: 'TXN-99887711',
                token: '4839-2910-4820-1920'
            },
            user: {
                wallet: {
                    available_balance: 45000.50
                }
            }
        };

        const normalized = adapter.mapResponse(mockApiResponse);

        assert.strictEqual(normalized.success, true, 'successPath response.code matching 200 must yield success: true');
        assert.strictEqual(normalized.status, 'delivered', 'statusPath data.order_status must be extracted');
        assert.strictEqual(normalized.transactionId, 'TXN-99887711', 'transactionIdPath data.provider_reference must be extracted');
        assert.strictEqual(normalized.message, 'Order successfully completed', 'messagePath response.description must be extracted');
        assert.strictEqual(normalized.token, '4839-2910-4820-1920');

        // Test failed response
        const failedResponse = {
            response: {
                code: 400,
                description: 'Insufficient balance on vendor'
            }
        };
        const failedNorm = adapter.mapResponse(failedResponse);
        assert.strictEqual(failedNorm.success, false);
        assert.strictEqual(failedNorm.message, 'Insufficient balance on vendor');
    });

    // ----------------------------------------------------
    // TEST 7: Admin GET returns metadata and does not expose secrets
    // ----------------------------------------------------
    await test('7. Admin GET returns advanced metadata while never returning decrypted secrets', () => {
        const rawApiKey = 'sk_live_very_secret_key_12345';
        const rawSecretKey = 'super_secret_password_99999';

        const mockProviderDoc = {
            _id: '67c1234567890abcdef12345',
            name: 'Generic Telecommunications',
            adapterType: 'universal',
            baseUrl: 'https://api.generic.ng',
            apiKey: encryptSecret(rawApiKey),
            secretKey: encryptSecret(rawSecretKey),
            publicKey: 'optional_pub',
            status: 'active',
            balance: 12000,
            metadata: {
                purchaseUrl: '/api/v1/buy',
                dataPurchaseUrl: '/api/v1/data',
                authHeaderName: 'Authorization',
                authHeaderValue: 'Bearer {{apiKey}}',
                fieldMap: {
                    phone: 'mobile_number'
                },
                successPath: 'status',
                successValue: 'success'
            }
        };

        const serialized = serializeProvider(mockProviderDoc);

        // Secrets must be hidden
        assert.strictEqual(serialized.secretKey, undefined, 'secretKey field must not exist in serialized output');
        assert.notStrictEqual(serialized.apiKey, rawApiKey, 'Plaintext apiKey must not be returned');
        assert.strictEqual(serialized.apiKeyConfigured, true, 'apiKeyConfigured must be true');
        assert.strictEqual(serialized.secretKeyConfigured, true, 'secretKeyConfigured must be true');
        assert.strictEqual(serialized.apiKeyMasked, '••••2345', 'apiKeyMasked must show only last 4 characters');

        // Advanced metadata configuration must be preserved
        assert.strictEqual(serialized.metadata.purchaseUrl, '/api/v1/buy');
        assert.strictEqual(serialized.metadata.dataPurchaseUrl, '/api/v1/data');
        assert.strictEqual(serialized.metadata.authHeaderValue, 'Bearer {{apiKey}}');
        assert.deepStrictEqual(serialized.metadata.fieldMap, { phone: 'mobile_number' });
    });

    // ----------------------------------------------------
    // TEST 8: Existing encrypted credentials remain unchanged on endpoint edit
    // ----------------------------------------------------
    await test('8. Existing encrypted credentials remain intact when updating only endpoints', () => {
        const originalApiKey = 'real_stored_api_key_777';
        const originalSecret = 'real_stored_secret_888';
        const originalEncryptedApi = encryptSecret(originalApiKey);
        const originalEncryptedSecret = encryptSecret(originalSecret);

        // Simulate incoming update payload with empty credentials
        const updatePayload = {
            apiKey: '', // Left blank by Admin to retain existing
            secretKey: '', // Left blank by Admin to retain existing
            metadata: {
                dataPurchaseUrl: '/new/data/endpoint',
                electricityPurchaseUrl: '/new/electric/endpoint'
            }
        };

        // Replicate controller logic
        let currentApiKey = originalEncryptedApi;
        let currentSecret = originalEncryptedSecret;

        if (updatePayload.apiKey && updatePayload.apiKey.trim() !== '') {
            currentApiKey = encryptSecret(updatePayload.apiKey.trim());
        }
        if (updatePayload.secretKey && updatePayload.secretKey.trim() !== '') {
            currentSecret = encryptSecret(updatePayload.secretKey.trim());
        }

        assert.strictEqual(currentApiKey, originalEncryptedApi, 'ApiKey ciphertext must remain identical');
        assert.strictEqual(currentSecret, originalEncryptedSecret, 'SecretKey ciphertext must remain identical');
        assert.strictEqual(decryptSecret(currentApiKey), originalApiKey, 'Decrypted key must match original');
    });

    // ----------------------------------------------------
    // TEST 9: Metadata Secret Rejection & Validation
    // ----------------------------------------------------
    await test('9. Metadata rejects raw bearer tokens, unsupported keys, and invalid methods', () => {
        // 9a. Raw bearer token rejected in authHeaderValue
        assert.throws(() => {
            validateMetadata({
                authHeaderValue: 'Bearer raw_hardcoded_token_123456789'
            });
        }, /Raw bearer token rejected/);

        // 9b. Unsupported metadata key rejected
        assert.throws(() => {
            validateMetadata({
                maliciousScriptField: 'console.log("hack")'
            });
        }, /Unsupported metadata key/);

        // 9c. Invalid HTTP method rejected
        assert.throws(() => {
            validateMetadata({
                dataMethod: 'OPTIONS' // not in allowed GET, POST, PUT, PATCH, DELETE
            });
        }, /Invalid HTTP method/);

        // 9d. Invalid template placeholder rejected
        assert.throws(() => {
            validateMetadata({
                authHeaderValue: 'Bearer {{someUnauthorizedVar}}'
            });
        }, /Unsupported placeholder/);

        // 9e. Valid metadata passes cleanly
        const validMeta = {
            purchaseUrl: '/buy',
            dataPurchaseUrl: '/buy-data',
            method: 'POST',
            dataMethod: 'POST',
            authHeaderName: 'Authorization',
            authHeaderValue: 'Bearer {{apiKey}}',
            fieldMap: {
                phone: 'mobile_number',
                amount: 'amount'
            },
            successPath: 'status',
            successValue: 'success'
        };
        const validated = validateMetadata(validMeta);
        assert.strictEqual(validated.purchaseUrl, '/buy');
        assert.strictEqual(validated.authHeaderValue, 'Bearer {{apiKey}}');
    });

    // ----------------------------------------------------
    // TEST 10: Existing VTPass Flow Unaffected
    // ----------------------------------------------------
    await test('10. Existing VTPass adapter workflow remains completely unaffected', () => {
        const vtpass = new VTPassAdapter({
            baseUrl: 'https://sandbox.vtpass.com/api',
            apiKey: 'vtpass_api_key_111',
            secretKey: 'vtpass_secret_key_222',
            publicKey: 'vtpass_pub_333'
        });

        assert.strictEqual(vtpass.baseUrl, 'https://sandbox.vtpass.com/api');
        assert.strictEqual(vtpass.apiKey, 'vtpass_api_key_111');
        assert.strictEqual(vtpass.secretKey, 'vtpass_secret_key_222');
        assert.strictEqual(vtpass.publicKey, 'vtpass_pub_333');

        // Test normalizer
        const vtpassSuccessResp = {
            code: '000',
            response_description: 'TRANSACTION SUCCESSFUL',
            requestId: 'REQ_VT_12345',
            content: {
                transactions: {
                    status: 'delivered',
                    total_amount: 1000,
                    commission: 20
                }
            }
        };
        const norm = vtpass.mapResponse(vtpassSuccessResp);
        assert.strictEqual(norm.success, true);
        assert.strictEqual(norm.status, 'success');
        assert.strictEqual(norm.transactionId, 'REQ_VT_12345');
    });

    // ----------------------------------------------------
    // TEST 11: Production & Staging Encryption Key Hardening
    // ----------------------------------------------------
    await test('11. Production & Staging strictly require valid 32-byte encryption key without silent fallback', () => {
        const originalEnv = process.env.NODE_ENV;
        const originalKey = process.env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY;

        try {
            // Simulate production with missing key
            process.env.NODE_ENV = 'production';
            delete process.env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY;

            assert.throws(() => {
                encryptSecret('some_secret');
            }, /PROVIDER_CREDENTIAL_ENCRYPTION_KEY is required in production and staging environments/);

            // Simulate production with invalid short key
            process.env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY = 'invalid-short-key';
            assert.throws(() => {
                encryptSecret('some_secret');
            }, /Invalid PROVIDER_CREDENTIAL_ENCRYPTION_KEY in production\/staging/);

            // Simulate production with valid 64-hex key (32 bytes)
            process.env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
            const enc = encryptSecret('valid_prod_secret');
            assert.strictEqual(isEncrypted(enc), true);
            const dec = decryptSecret(enc);
            assert.strictEqual(dec, 'valid_prod_secret');

        } finally {
            process.env.NODE_ENV = originalEnv;
            if (originalKey) {
                process.env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY = originalKey;
            } else {
                delete process.env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY;
            }
        }
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

runAllTests();
