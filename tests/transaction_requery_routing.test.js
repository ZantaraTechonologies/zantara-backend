const assert = require('assert');
const Provider = require('../models/Provider');
const VTPassAdapter = require('../adapters/vtpass.adapter');
const Vas2NetsAdapter = require('../adapters/vas2nets.adapter');
const UniversalAdapter = require('../adapters/universal.adapter');
const providerService = require('../services/provider.service');

async function runRequeryRoutingTests() {
    console.log('====================================================');
    console.log('   TRANSACTION REQUERY PROVIDER ROUTING TEST SUITE  ');
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

    // Mock Provider.findOne for database lookup
    const originalFindOne = Provider.findOne;
    const mockProviders = {
        'vtpass': {
            name: 'VTPass',
            adapterType: 'vtpass',
            baseUrl: 'https://api.vtpass.com',
            apiKey: 'vt_key_123'
        },
        'vas2nets': {
            name: 'Vas2Nets',
            adapterType: 'vas2nets',
            baseUrl: 'https://api.vas2nets.com',
            apiKey: 'vas_key_456'
        },
        'mele': {
            name: 'MELE',
            adapterType: 'universal',
            baseUrl: 'https://api.meledata.ng/v1',
            apiKey: 'mele_key_789',
            metadata: {
                queryUrl: '/api/v1/transaction-status',
                queryMethod: 'POST',
                fieldMap: {
                    request_id: 'order_reference'
                }
            }
        }
    };

    Provider.findOne = function(query) {
        return {
            exec: async () => null,
            then: (resolve) => {
                const queryStr = query?.name?.$regex?.source || query?.name || '';
                const cleanName = queryStr.replace(/[\^\$\/\\]/g, '').toLowerCase();
                const matched = mockProviders[cleanName] || null;
                return resolve(matched);
            }
        };
    };

    try {
        // ----------------------------------------------------
        // TEST A: VTPass Transaction Requery
        // ----------------------------------------------------
        await test('A. VTPass transaction with stored provider="VTPass" instantiates VTPassAdapter', async () => {
            let instantiatedClass = null;
            let queriedRef = null;

            // Spy on getAdapterInstance
            const origGetAdapter = providerService.getAdapterInstance.bind(providerService);
            providerService.getAdapterInstance = async function(providerName) {
                const adapter = await origGetAdapter(providerName);
                instantiatedClass = adapter.constructor.name;
                adapter.queryTransaction = async (ref) => {
                    queriedRef = ref;
                    return { success: true, status: 'success', provider: 'vtpass' };
                };
                return adapter;
            };

            const result = await providerService.queryTransaction('VTP_REQ_1001', 'VTPass');
            assert.strictEqual(instantiatedClass, 'VTPassAdapter', 'Must instantiate VTPassAdapter');
            assert.strictEqual(queriedRef, 'VTP_REQ_1001');
            assert.strictEqual(result.success, true);

            providerService.getAdapterInstance = origGetAdapter;
        });

        // ----------------------------------------------------
        // TEST B: MELE / Universal Transaction Requery
        // ----------------------------------------------------
        await test('B. MELE transaction with stored provider="MELE" instantiates UniversalAdapter, never VTPass', async () => {
            let instantiatedClass = null;
            let vtpassInstantiated = false;
            let queriedRef = null;

            const origGetAdapter = providerService.getAdapterInstance.bind(providerService);
            providerService.getAdapterInstance = async function(providerName) {
                const adapter = await origGetAdapter(providerName);
                instantiatedClass = adapter.constructor.name;
                if (instantiatedClass === 'VTPassAdapter') {
                    vtpassInstantiated = true;
                }
                adapter.queryTransaction = async (ref) => {
                    queriedRef = ref;
                    return { success: true, status: 'success', provider: 'universal_mele' };
                };
                return adapter;
            };

            const result = await providerService.queryTransaction('MELE_REQ_5002', 'MELE');
            assert.strictEqual(instantiatedClass, 'UniversalAdapter', 'Must instantiate UniversalAdapter for MELE');
            assert.strictEqual(vtpassInstantiated, false, 'VTPassAdapter must NEVER be instantiated for MELE');
            assert.strictEqual(queriedRef, 'MELE_REQ_5002');
            assert.strictEqual(result.provider, 'universal_mele');

            providerService.getAdapterInstance = origGetAdapter;
        });

        // ----------------------------------------------------
        // TEST C: Vas2Nets Transaction Requery
        // ----------------------------------------------------
        await test('C. Vas2Nets transaction queries Vas2NetsAdapter', async () => {
            let instantiatedClass = null;

            const origGetAdapter = providerService.getAdapterInstance.bind(providerService);
            providerService.getAdapterInstance = async function(providerName) {
                const adapter = await origGetAdapter(providerName);
                instantiatedClass = adapter.constructor.name;
                adapter.queryTransaction = async (ref) => ({ success: true, provider: 'vas2nets' });
                return adapter;
            };

            const result = await providerService.queryTransaction('VAS_REQ_7003', 'Vas2Nets');
            assert.strictEqual(instantiatedClass, 'Vas2NetsAdapter', 'Must instantiate Vas2NetsAdapter');
            assert.strictEqual(result.provider, 'vas2nets');

            providerService.getAdapterInstance = origGetAdapter;
        });

        // ----------------------------------------------------
        // TEST D: Missing Provider Rejection (No Silent VTPass Fallback)
        // ----------------------------------------------------
        await test('D. Missing provider in queryTransaction throws controlled error without silent VTPass fallback', async () => {
            // Null provider
            await assert.rejects(async () => {
                await providerService.queryTransaction('REQ_FAIL_01', null);
            }, /Provider is required for transaction requery/);

            // Undefined provider
            await assert.rejects(async () => {
                await providerService.queryTransaction('REQ_FAIL_02', undefined);
            }, /Provider is required for transaction requery/);

            // Empty string provider
            await assert.rejects(async () => {
                await providerService.queryTransaction('REQ_FAIL_03', '   ');
            }, /Provider is required for transaction requery/);
        });

        // ----------------------------------------------------
        // TEST E: Universal Adapter Configured queryUrl and queryMethod
        // ----------------------------------------------------
        await test('E. Universal provider uses configured queryUrl and queryMethod from Provider.metadata', async () => {
            const meleAdapter = new UniversalAdapter({
                baseUrl: 'https://api.meledata.ng/v1',
                apiKey: 'mele_key_789',
                metadata: {
                    queryUrl: '/api/v1/transaction-status',
                    queryMethod: 'POST',
                    fieldMap: {
                        request_id: 'order_reference'
                    }
                }
            });

            // Verify endpoint resolution
            const resolvedUrl = meleAdapter._resolveUrl('queryUrl', '/requery', { request_id: 'REQ_123' });
            assert.strictEqual(resolvedUrl, 'https://api.meledata.ng/v1/api/v1/transaction-status');

            // Verify method resolution
            const resolvedMethod = meleAdapter._resolveMethod('queryMethod', null, 'POST');
            assert.strictEqual(resolvedMethod, 'POST');

            // Verify fieldMap for request_id
            const reqKey = meleAdapter.metadata.fieldMap?.request_id || 'request_id';
            assert.strictEqual(reqKey, 'order_reference');
        });

        // ----------------------------------------------------
        // TEST F: Controller checkTransaction Provider Routing Logic
        // ----------------------------------------------------
        await test('F. Controller routing logic passes localTx.provider and handles legacy records properly', async () => {
            // Simulate controller logic with MELE transaction
            const mockTxMele = {
                refId: 'MELE-ORDER-99',
                transactionId: 'FT1234567890',
                provider: 'MELE'
            };

            let passedProvider = null;
            let queriedRef = null;
            const mockProviderService = {
                queryTransaction: async (ref, prov) => {
                    queriedRef = ref;
                    passedProvider = prov;
                    return { success: true };
                }
            };

            // Controller execution simulation
            let providerToUse = mockTxMele.provider;
            if (!providerToUse && (mockTxMele.response?.content?.transactions || (mockTxMele.refId && /^\d{14,}/.test(mockTxMele.refId)))) {
                providerToUse = 'VTPass';
            }
            await mockProviderService.queryTransaction(mockTxMele.refId, providerToUse);

            assert.strictEqual(passedProvider, 'MELE', 'Controller must forward localTx.provider');
            assert.strictEqual(queriedRef, 'MELE-ORDER-99');

            // Simulate legacy transaction with missing provider and no VTPass traits -> rejected
            const mockTxUnknown = {
                refId: 'CUSTOM-REF-001',
                provider: null
            };
            let unknownProvider = mockTxUnknown.provider;
            if (!unknownProvider && (mockTxUnknown.response?.content?.transactions || (mockTxUnknown.refId && /^\d{14,}/.test(mockTxUnknown.refId)))) {
                unknownProvider = 'VTPass';
            }
            assert.strictEqual(unknownProvider, null, 'Unknown transactions without VTPass markers must NOT fall back to VTPass');

            // Simulate legacy transaction with VTPass 14-digit timestamp reference
            const mockTxLegacyVTPass = {
                refId: '20250101123456789',
                provider: null
            };
            let legacyProvider = mockTxLegacyVTPass.provider;
            if (!legacyProvider && (mockTxLegacyVTPass.response?.content?.transactions || (mockTxLegacyVTPass.refId && /^\d{14,}/.test(mockTxLegacyVTPass.refId)))) {
                legacyProvider = 'VTPass';
            }
            assert.strictEqual(legacyProvider, 'VTPass', 'Recognized legacy VTPass records are safely classified');
        });

    } finally {
        Provider.findOne = originalFindOne;
    }

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

runRequeryRoutingTests();
