const assert = require('assert');
const mongoose = require('mongoose');

// Models & Services
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Service = require('../models/Service');
const ServiceIdentity = require('../models/ServiceIdentity');
const Expense = require('../models/Expense');
const pinService = require('../services/pin.service');
const walletService = require('../services/wallet.service');
const notificationService = require('../services/notification.service');
const purchaseService = require('../services/purchase.service');
const referral = require('../utils/referral');
const pricing = require('../utils/pricing');
const { sendResponse } = require('../utils/response');

async function runPostPurchaseResponseTests() {
    console.log('====================================================');
    console.log('   POST-PURCHASE SUCCESS RESPONSE & NOTIF TEST SUITE');
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
            console.error(`   Error: ${err.message}\n`, err.stack);
            failed++;
        }
    }

    // Save originals for restoration
    const origVerifyPin = pinService.verifyPin;
    const origUserFindById = User.findById;
    const origServiceFindOne = Service.findOne;
    const origServiceIdentityFindOne = ServiceIdentity.findOne;
    const origWalletFindOne = Wallet.findOne;
    const origWalletDebit = walletService.debit;
    const origTxCreate = Transaction.create;
    const origExpenseCreate = Expense.create;
    const origCommission = referral.processLifetimeCommission;
    const origGetProviderCost = pricing.getProviderCost;
    const origCalculatePrice = pricing.calculateServicePrice;
    const origStartSession = mongoose.startSession;
    const origNotify = notificationService.notify;

    // Standard test mocks
    const mockUser = {
        _id: new mongoose.Types.ObjectId(),
        name: 'Test Customer',
        email: 'customer@test.com',
        phone: '08012345678',
        role: 'user',
        kycLevel: 2
    };

    pinService.verifyPin = async () => true;
    User.findById = () => ({
        select: () => mockUser,
        ...mockUser,
        then: (cb) => Promise.resolve(cb(mockUser))
    });
    Service.findOne = async () => null;
    ServiceIdentity.findOne = async () => null;
    Wallet.findOne = async () => ({ balance: 50000 });
    walletService.debit = async () => true;
    Expense.create = async () => [];
    referral.processLifetimeCommission = async () => 0;
    pricing.getProviderCost = async (serviceId, amount) => amount * 0.98;
    pricing.calculateServicePrice = async (user, amount) => amount;

    // Mock mongoose session transaction
    mongoose.startSession = async () => ({
        startTransaction: () => {},
        commitTransaction: async () => {},
        abortTransaction: async () => {},
        endSession: () => {}
    });

    const createMockTx = (doc) => ({
        ...doc,
        save: async () => {},
        _id: new mongoose.Types.ObjectId(),
        transactionId: 'TXN-TEST-123456'
    });

    Transaction.create = async (doc) => createMockTx(doc);

    try {
        // TEST 1: Normalized Success Response Structure (Airtime)
        await test('1. Airtime returns normalized { success, status, message, reference, transactionId }', async () => {
            let savedTx = null;
            Transaction.create = async (doc) => {
                savedTx = createMockTx(doc);
                return savedTx;
            };

            const result = await purchaseService.processPurchase(mockUser._id, {
                type: 'airtime',
                serviceId: 'mtn',
                amount: 1000,
                pin: '1234',
                details: { phone: '08012345678' },
                providerCall: async (refId) => ({
                    success: true,
                    status: 'success',
                    message: 'Airtime delivered',
                    transactionId: 'VTP-AIR-998877',
                    raw: { code: '000' }
                })
            });

            assert.strictEqual(result.success, true, 'Result success must be true');
            assert.strictEqual(result.data.status, 'success', 'Status must be success');
            assert.ok(result.data.reference, 'Must contain Zantara reference');
            assert.strictEqual(result.data.transactionId, 'TXN-TEST-123456', 'Must contain transactionId');
            assert.strictEqual(result.data.providerTransactionId, 'VTP-AIR-998877', 'Must retain providerTransactionId');
            assert.strictEqual(savedTx.status, 'success', 'DB record status must be success');
        });

        // TEST 2: Notifications are Non-Blocking (Slow SMTP / SMS does not delay return)
        await test('2. Slow notification delivery does not block HTTP purchase response', async () => {
            let notificationFinished = false;
            notificationService.notify = async () => {
                // Simulate slow 1000ms delay in notification pipeline (SMTP / SMS)
                await new Promise(r => setTimeout(r, 1000));
                notificationFinished = true;
            };

            const startTime = Date.now();
            const result = await purchaseService.processPurchase(mockUser._id, {
                type: 'airtime',
                serviceId: 'glo',
                amount: 500,
                pin: '1234',
                details: { phone: '08055555555' },
                providerCall: async () => ({
                    success: true,
                    status: 'success',
                    message: 'Glo airtime successful',
                    transactionId: 'VTP-GLO-112233'
                })
            });
            const duration = Date.now() - startTime;

            assert.strictEqual(result.success, true);
            // Must return in < 200ms without awaiting the 1000ms notification
            assert.ok(duration < 200, `processPurchase returned in ${duration}ms (must be < 200ms)`);
            assert.strictEqual(notificationFinished, false, 'Notification must still be running in background');
        });

        // TEST 3: Notification Failure Does Not Fail the Purchase
        await test('3. SMTP/SMS/Push rejection does not fail or change successful purchase', async () => {
            let errorLogged = false;
            const originalConsoleError = console.error;
            console.error = (msg, err) => {
                if (String(msg).includes('[Notification Background Error]')) {
                    errorLogged = true;
                }
            };

            notificationService.notify = () => Promise.reject(new Error('SMTP Connection Refused (Port 587 Timeout)'));

            const result = await purchaseService.processPurchase(mockUser._id, {
                type: 'data',
                serviceId: 'mtn-data-1gb',
                amount: 300,
                pin: '1234',
                details: { phone: '08012345678' },
                providerCall: async () => ({
                    success: true,
                    status: 'success',
                    message: 'Data credited',
                    transactionId: 'VTP-DAT-445566'
                })
            });

            // Wait a tick for the background catch handler to execute
            await new Promise(r => setTimeout(r, 30));
            console.error = originalConsoleError;

            assert.strictEqual(result.success, true, 'Purchase must still succeed');
            assert.strictEqual(result.data.status, 'success');
            assert.strictEqual(errorLogged, true, 'Notification error must be caught and logged in background');
        });

        // TEST 4: Electricity Purchase Retains Token
        await test('4. Electricity purchase normalizes response and retains generated meter token', async () => {
            const result = await purchaseService.processPurchase(mockUser._id, {
                type: 'electricity',
                serviceId: 'ikeja-electric',
                amount: 2000,
                pin: '1234',
                details: { meter_number: '11223344556' },
                providerCall: async () => ({
                    success: true,
                    status: 'success',
                    message: 'Token generated',
                    transactionId: 'IKJ-ELEC-7788',
                    token: '4829-1920-4820-1928-4829'
                })
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.data.status, 'success');
            assert.strictEqual(result.data.token, '4829-1920-4820-1928-4829');
            assert.ok(result.data.reference);
            assert.ok(result.data.transactionId);
        });

        // TEST 5: Cable TV Purchase Normalization
        await test('5. Cable TV subscription normalizes response and reference cleanly', async () => {
            const result = await purchaseService.processPurchase(mockUser._id, {
                type: 'cable',
                serviceId: 'dstv-padi',
                amount: 3500,
                pin: '1234',
                details: { billersCode: '1029384756' },
                providerCall: async () => ({
                    success: true,
                    status: 'success',
                    message: 'DStv renewed successfully',
                    transactionId: 'DSTV-998811'
                })
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.data.status, 'success');
            assert.strictEqual(result.data.message, 'DStv renewed successfully');
            assert.ok(result.data.reference);
            assert.ok(result.data.transactionId);
        });

        // TEST 6: Exam PIN Purchase Normalization
        await test('6. Exam PIN purchase normalizes response and retains generated card/pin', async () => {
            const result = await purchaseService.processPurchase(mockUser._id, {
                type: 'pin',
                serviceId: 'waec-pin',
                amount: 4000,
                pin: '1234',
                details: { phone: '08012345678', quantity: 1 },
                providerCall: async () => ({
                    success: true,
                    status: 'success',
                    message: 'WAEC PIN generated',
                    transactionId: 'WAEC-887766',
                    token: 'WAEC-PIN-1234-5678-9012'
                })
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.data.status, 'success');
            assert.strictEqual(result.data.token, 'WAEC-PIN-1234-5678-9012');
            assert.ok(result.data.reference);
            assert.ok(result.data.transactionId);
        });

        // TEST 7: sendResponse Formatter Wraps Normalized Data with HTTP 200
        await test('7. sendResponse returns HTTP 200 with standard client envelope', () => {
            let capturedStatus = null;
            let capturedJson = null;

            const res = {
                status: (code) => {
                    capturedStatus = code;
                    return {
                        json: (payload) => {
                            capturedJson = payload;
                            return payload;
                        }
                    };
                }
            };

            const sampleNormalizedData = {
                success: true,
                status: 'success',
                message: 'Airtime delivered',
                reference: 'ZNT-REF-100200',
                transactionId: 'TXN-998877'
            };

            sendResponse(res, { message: 'Airtime sent successfully', data: sampleNormalizedData });

            assert.strictEqual(capturedStatus, 200);
            assert.strictEqual(capturedJson.success, true);
            assert.strictEqual(capturedJson.message, 'Airtime sent successfully');
            assert.strictEqual(capturedJson.data.reference, 'ZNT-REF-100200');
            assert.strictEqual(capturedJson.data.transactionId, 'TXN-998877');
            assert.strictEqual(capturedJson.data.status, 'success');
        });

    } finally {
        // Restore all mocked functions
        pinService.verifyPin = origVerifyPin;
        User.findById = origUserFindById;
        Service.findOne = origServiceFindOne;
        ServiceIdentity.findOne = origServiceIdentityFindOne;
        Wallet.findOne = origWalletFindOne;
        walletService.debit = origWalletDebit;
        Transaction.create = origTxCreate;
        Expense.create = origExpenseCreate;
        referral.processLifetimeCommission = origCommission;
        pricing.getProviderCost = origGetProviderCost;
        pricing.calculateServicePrice = origCalculatePrice;
        mongoose.startSession = origStartSession;
        notificationService.notify = origNotify;
    }

    console.log('\n----------------------------------------------------');
    console.log(`Test Execution Finished: ${passed} PASSED, ${failed} FAILED.`);
    console.log('----------------------------------------------------\n');

    process.exit(failed > 0 ? 1 : 0);
}

runPostPurchaseResponseTests();
