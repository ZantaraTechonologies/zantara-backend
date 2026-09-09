const assert = require('assert');
const mongoose = require('mongoose');

// Models & Services
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Wallet = require('../models/Wallet');
const Service = require('../models/Service');
const ServiceIdentity = require('../models/ServiceIdentity');
const Expense = require('../models/Expense');
const Setting = require('../models/Setting');
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
    const origSettingFindOne = Setting.findOne;
    const origSettingFind = Setting.find;
    const origWalletDebit = walletService.debit;
    const origTxCreate = Transaction.create;
    const origExpenseCreate = Expense.create;
    const origCommission = referral.processLifetimeCommission;
    const origGetProviderCost = pricing.getProviderCost;
    const origCalculatePrice = pricing.calculateServicePrice;
    const origStartSession = mongoose.startSession;
    const origNotify = notificationService.notify.bind(notificationService);
    const origSendInApp = notificationService.sendInApp.bind(notificationService);
    const origSendEmail = notificationService.sendEmail.bind(notificationService);
    const origSendSMS = notificationService.sendSMS.bind(notificationService);

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
    const mockSettingChain = (val) => ({
        session: () => mockSettingChain(val),
        lean: () => mockSettingChain(val),
        then: (cb) => Promise.resolve(cb(val)),
        catch: () => Promise.resolve(val)
    });
    Setting.findOne = () => mockSettingChain(null);
    Setting.find = () => mockSettingChain([]);
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
        // ─────────────────────────────────────────────────────────────────────
        // ORIGINAL TESTS (Preserved)
        // ─────────────────────────────────────────────────────────────────────

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
            assert.ok(duration < 200, `processPurchase returned in ${duration}ms (must be < 200ms)`);
            assert.strictEqual(notificationFinished, false, 'Notification must still be running in background');
        });

        // TEST 3: Notification Failure Does Not Fail the Purchase
        await test('3. SMTP/SMS/Push rejection does not fail or change successful purchase', async () => {
            let errorLogged = false;
            const originalConsoleError = console.error;
            console.error = (msg) => {
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

            sendResponse(res, { message: 'Airtime sent successfully', data: {
                success: true,
                status: 'success',
                message: 'Airtime delivered',
                reference: 'ZNT-REF-100200',
                transactionId: 'TXN-998877'
            }});

            assert.strictEqual(capturedStatus, 200);
            assert.strictEqual(capturedJson.success, true);
            assert.strictEqual(capturedJson.message, 'Airtime sent successfully');
            assert.strictEqual(capturedJson.data.reference, 'ZNT-REF-100200');
            assert.strictEqual(capturedJson.data.transactionId, 'TXN-998877');
            assert.strictEqual(capturedJson.data.status, 'success');
        });

        // ─────────────────────────────────────────────────────────────────────
        // NEW TESTS — Notification Non-Blocking Hardening
        // ─────────────────────────────────────────────────────────────────────

        // TEST 8: Slow SMTP does not delay purchase success response
        await test('8. Slow SMTP (2s simulated) does not delay purchase success response', async () => {
            notificationService.notify = origNotify;
            notificationService.sendInApp = async () => ({ _id: 'notif-001' });
            notificationService.sendEmail = async () => {
                await new Promise(r => setTimeout(r, 2000));
            };
            notificationService.sendSMS = async () => {};

            const start = Date.now();
            const result = await purchaseService.processPurchase(mockUser._id, {
                type: 'airtime',
                serviceId: 'airtel',
                amount: 200,
                pin: '1234',
                details: { phone: '08099999999' },
                providerCall: async () => ({
                    success: true, status: 'success',
                    message: 'Airtel ok', transactionId: 'VTP-SMTP-TEST'
                })
            });
            const duration = Date.now() - start;

            notificationService.sendEmail = origSendEmail;
            notificationService.sendSMS = origSendSMS;
            notificationService.sendInApp = origSendInApp;

            assert.strictEqual(result.success, true, 'Purchase must succeed');
            assert.ok(duration < 500, `Must arrive in <500ms even with 2s SMTP, took: ${duration}ms`);
        });

        // TEST 9: Slow SMS does not delay purchase success response
        await test('9. Slow SMS (2s simulated) does not delay purchase success response', async () => {
            notificationService.notify = origNotify;
            notificationService.sendInApp = async () => ({ _id: 'notif-002' });
            notificationService.sendEmail = async () => {};
            notificationService.sendSMS = async () => {
                await new Promise(r => setTimeout(r, 2000));
            };

            const start = Date.now();
            const result = await purchaseService.processPurchase(mockUser._id, {
                type: 'airtime',
                serviceId: 'mtn',
                amount: 100,
                pin: '1234',
                details: { phone: '08011111111' },
                providerCall: async () => ({
                    success: true, status: 'success',
                    message: 'MTN ok', transactionId: 'VTP-SMS-TEST'
                })
            });
            const duration = Date.now() - start;

            notificationService.sendEmail = origSendEmail;
            notificationService.sendSMS = origSendSMS;
            notificationService.sendInApp = origSendInApp;

            assert.strictEqual(result.success, true, 'Purchase must succeed');
            assert.ok(duration < 500, `Must arrive in <500ms even with 2s SMS, took: ${duration}ms`);
        });

        // TEST 10: Slow referral notification does not delay transaction completion
        await test('10. Slow referral notification does not delay transaction completion', async () => {
            notificationService.notify = async () => {
                await new Promise(r => setTimeout(r, 2000));
            };

            let commissionCalled = false;
            referral.processLifetimeCommission = async () => {
                commissionCalled = true;
                // Simulate fire-and-forget notify in referral.js
                notificationService.notify({}, {}).catch(() => {});
                return 15;
            };

            const start = Date.now();
            const result = await purchaseService.processPurchase(mockUser._id, {
                type: 'airtime',
                serviceId: 'mtn',
                amount: 1000,
                pin: '1234',
                details: { phone: '08033333333' },
                providerCall: async () => ({
                    success: true, status: 'success',
                    message: 'Airtime ok', transactionId: 'VTP-REFERRAL-TEST'
                })
            });
            const duration = Date.now() - start;

            referral.processLifetimeCommission = origCommission;

            assert.strictEqual(result.success, true, 'Purchase must succeed');
            assert.ok(commissionCalled, 'Commission function must be called');
            assert.ok(duration < 500, `Must arrive in <500ms, took: ${duration}ms`);
        });

        // TEST 11: Notification failure does not change Transaction.status from 'success'
        await test('11. Notification failure does not change Transaction.status from success', async () => {
            notificationService.notify = () => Promise.reject(new Error('SMTP Down'));

            const result = await purchaseService.processPurchase(mockUser._id, {
                type: 'airtime',
                serviceId: 'mtn',
                amount: 500,
                pin: '1234',
                details: { phone: '08044444444' },
                providerCall: async () => ({
                    success: true, status: 'success',
                    message: 'Airtime ok', transactionId: 'VTP-STATUS-TEST'
                })
            });

            await new Promise(r => setTimeout(r, 30));

            assert.strictEqual(result.success, true, 'Result must succeed');
            assert.strictEqual(result.data.status, 'success', 'Data status must be success');
        });

        // TEST 12: Notification failure does not trigger refund
        await test('12. Notification failure does not trigger wallet refund', async () => {
            let refundCalled = false;
            const refundService = require('../services/refund.service');
            const origProcessRefund = refundService.processRefund;
            refundService.processRefund = async () => { refundCalled = true; };

            notificationService.notify = () => Promise.reject(new Error('Termii 503'));

            const result = await purchaseService.processPurchase(mockUser._id, {
                type: 'airtime',
                serviceId: 'glo',
                amount: 200,
                pin: '1234',
                details: { phone: '08055555555' },
                providerCall: async () => ({
                    success: true, status: 'success',
                    message: 'Glo ok', transactionId: 'VTP-REFUND-TEST'
                })
            });

            await new Promise(r => setTimeout(r, 50));
            refundService.processRefund = origProcessRefund;

            assert.strictEqual(result.success, true, 'Purchase must succeed');
            assert.strictEqual(refundCalled, false, 'Refund must NOT be triggered by notification failure');
        });

        // TEST 13: Referral commission amount is correct regardless of notification failure
        await test('13. Referral commission amount is correct even if notification fails', async () => {
            let commissionPaid = null;

            referral.processLifetimeCommission = async (userId, amount) => {
                commissionPaid = Math.round(amount * 0.01);
                notificationService.notify({}, {}).catch(() => {});
                return commissionPaid;
            };

            notificationService.notify = () => Promise.reject(new Error('Push Token Invalid'));

            const result = await purchaseService.processPurchase(mockUser._id, {
                type: 'airtime',
                serviceId: 'mtn',
                amount: 5000,
                pin: '1234',
                details: { phone: '08066666666' },
                providerCall: async () => ({
                    success: true, status: 'success',
                    message: 'Airtime ok', transactionId: 'VTP-COMM-TEST'
                })
            });

            await new Promise(r => setTimeout(r, 50));
            referral.processLifetimeCommission = origCommission;

            assert.strictEqual(result.success, true, 'Purchase must succeed');
            assert.strictEqual(commissionPaid, 50, `Commission must be 50 (1% of 5000), got: ${commissionPaid}`);
        });

        // TEST 14: notify() itself returns before email/SMS delivery completes
        await test('14. notify() returns before slow email and SMS delivery complete', async () => {
            notificationService.notify = origNotify;

            let emailFinished = false;
            let smsFinished = false;

            notificationService.sendInApp = async () => ({ _id: 'notif-fast' });
            notificationService.sendEmail = async () => {
                await new Promise(r => setTimeout(r, 2000));
                emailFinished = true;
            };
            notificationService.sendSMS = async () => {
                await new Promise(r => setTimeout(r, 1500));
                smsFinished = true;
            };

            const mockUserWithContacts = {
                _id: new mongoose.Types.ObjectId(),
                email: 'test@zantara.ng',
                phone: '08077777777'
            };

            const start = Date.now();
            await notificationService.notify(mockUserWithContacts, {
                title: 'Test', message: 'Test msg',
                emailHtml: '<p>Test</p>', emailSubject: 'Test Subject',
                smsMessage: 'Test SMS', type: 'test'
            });
            const duration = Date.now() - start;

            notificationService.sendEmail = origSendEmail;
            notificationService.sendSMS = origSendSMS;
            notificationService.sendInApp = origSendInApp;

            assert.ok(duration < 200, `notify() must return in <200ms, took: ${duration}ms`);
            assert.strictEqual(emailFinished, false, 'Email must still be in-flight when notify() returns');
            assert.strictEqual(smsFinished, false, 'SMS must still be in-flight when notify() returns');
        });

        // TEST 15: All three external channels fail independently without crashing notify()
        await test('15. Email, SMS, and push failures are each isolated — notify() does not throw', async () => {
            notificationService.notify = origNotify;
            notificationService.sendInApp = async () => ({ _id: 'notif-isolated' });
            notificationService.sendEmail = async () => { throw new Error('SMTP Refused'); };
            notificationService.sendSMS = async () => { throw new Error('Termii 500'); };

            const mockUserWithContacts = {
                _id: new mongoose.Types.ObjectId(),
                email: 'test@zantara.ng',
                phone: '08088888888'
            };

            // notify() must NOT throw even when all channels fail
            let threw = false;
            try {
                await notificationService.notify(mockUserWithContacts, {
                    title: 'Test', message: 'Test', type: 'test',
                    emailHtml: '<p>X</p>', emailSubject: 'X',
                    smsMessage: 'X', activityType: null
                });
            } catch (e) {
                threw = true;
            }

            await new Promise(r => setTimeout(r, 100));
            notificationService.sendEmail = origSendEmail;
            notificationService.sendSMS = origSendSMS;
            notificationService.sendInApp = origSendInApp;

            assert.strictEqual(threw, false, 'notify() must never throw even when all channels fail');
        });

    } finally {
        // Restore all mocked functions
        pinService.verifyPin = origVerifyPin;
        User.findById = origUserFindById;
        Service.findOne = origServiceFindOne;
        ServiceIdentity.findOne = origServiceIdentityFindOne;
        Wallet.findOne = origWalletFindOne;
        Setting.findOne = origSettingFindOne;
        Setting.find = origSettingFind;
        walletService.debit = origWalletDebit;
        Transaction.create = origTxCreate;
        Expense.create = origExpenseCreate;
        referral.processLifetimeCommission = origCommission;
        pricing.getProviderCost = origGetProviderCost;
        pricing.calculateServicePrice = origCalculatePrice;
        mongoose.startSession = origStartSession;
        notificationService.notify = origNotify;
        notificationService.sendInApp = origSendInApp;
        notificationService.sendEmail = origSendEmail;
        notificationService.sendSMS = origSendSMS;
    }

    console.log('\n----------------------------------------------------');
    console.log(`Test Execution Finished: ${passed} PASSED, ${failed} FAILED.`);
    console.log('----------------------------------------------------\n');

    process.exit(failed > 0 ? 1 : 0);
}

runPostPurchaseResponseTests();
