const assert = require('assert');
const mongoose = require('mongoose');

// Models & Services
const Notification = require('../models/Notification');
const User = require('../models/User');
const Setting = require('../models/Setting');
const Transaction = require('../models/Transaction');
const Expense = require('../models/Expense');
const Wallet = require('../models/Wallet');
const Service = require('../models/Service');
const ServiceIdentity = require('../models/ServiceIdentity');
const ShareExitRequest = require('../models/ShareExitRequest');
const InvestmentWithdrawal = require('../models/InvestmentWithdrawal');

const pinService = require('../services/pin.service');
const walletService = require('../services/wallet.service');
const notificationService = require('../services/notification.service');
const purchaseService = require('../services/purchase.service');
const pricingService = require('../services/pricing.service');
const procurementService = require('../services/procurement.service');
const referral = require('../utils/referral');
const pricing = require('../utils/pricing');
const auditController = require('../controllers/auditController');

async function runNotificationDedupTests() {
    console.log('====================================================');
    console.log('   NOTIFICATION FAN-OUT DEDUP & AFTER-COMMIT TEST SUITE');
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

    // ─────────────────────────────────────────────────────────────
    // ORIGINAL REFERENCE SNAPSHOTS (restored in the global finally)
    // ─────────────────────────────────────────────────────────────
    const O = {
        NF: Notification.findOne,
        NC: Notification.create,
        UF: User.findById,
        SF: Setting.find,
        SF1: Setting.findOne,
        sendPush: notificationService.sendPush.bind(notificationService),
        sendEmail: notificationService.sendEmail.bind(notificationService),
        sendSMS: notificationService.sendSMS.bind(notificationService),
        sendInApp: notificationService.sendInApp.bind(notificationService),
        notifyReferralEarned: notificationService.notifyReferralEarned.bind(notificationService),
        notifyPurchaseSuccess: notificationService.notifyPurchaseSuccess.bind(notificationService),
        startSession: mongoose.startSession,
        processLifetimeCommission: referral.processLifetimeCommission,
        verifyPin: pinService.verifyPin,
        ServiceFindOne: Service.findOne,
        ServiceIdentityFindOne: ServiceIdentity.findOne,
        WalletFindOne: Wallet.findOne,
        walletCredit: walletService.credit,
        walletDebit: walletService.debit,
        TransactionCreate: Transaction.create,
        TransactionFindById: Transaction.findById,
        TransactionFindOneAndUpdate: Transaction.findOneAndUpdate,
        TransactionUpdateOne: Transaction.updateOne,
        ExpenseCreate: Expense.create,
        getProviderCost: pricing.getProviderCost,
        calculateServicePrice: pricing.calculateServicePrice,
        resolvePricing: pricingService.resolvePricing,
        selectBestOffer: procurementService.selectBestOffer,
        logAction: auditController.logAction,
        ShareExitFindById: ShareExitRequest.findById,
        ShareExitFindOneAndUpdate: ShareExitRequest.findOneAndUpdate,
        InvestmentWithdrawalFindById: InvestmentWithdrawal.findById,
        InvestmentWithdrawalFindOneAndUpdate: InvestmentWithdrawal.findOneAndUpdate,
    };

    // ─────────────────────────────────────────────────────────────
    // IN-MEMORY "notifications" COLLECTION THAT MIRRORS THE
    // SPARSE UNIQUE INDEX { userId: 1, eventKey: 1 }.
    //   - docs WITHOUT eventKey never participate (sparse)
    //   - a second create for the same (userId, eventKey) throws 11000
    // ─────────────────────────────────────────────────────────────
    const store = new Map();
    let createdRecords = [];
    function resetDedupState() {
        store.clear();
        createdRecords = [];
        pushCount = 0;
        emailCount = 0;
        smsCount = 0;
    }
    let pushCount = 0;
    let emailCount = 0;
    let smsCount = 0;

    Notification.findOne = ({ userId, eventKey }) => ({
        lean: async () => {
            if (!eventKey) return null;
            return store.has(`${userId}:${eventKey}`) ? { ...store.get(`${userId}:${eventKey}`) } : null;
        },
    });
    Notification.create = async (doc) => {
        const rec = {
            _id: new mongoose.Types.ObjectId(),
            isRead: false,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...doc,
        };
        if (doc.eventKey) {
            const key = `${doc.userId}:${doc.eventKey}`;
            if (store.has(key)) {
                const err = new Error('E11000 duplicate key error collection: notifications');
                err.code = 11000;
                throw err;
            }
            store.set(key, rec);
        }
        createdRecords.push(rec);
        return rec;
    };

    const FULL_USER = {
        _id: new mongoose.Types.ObjectId(),
        name: 'Ada Test',
        email: 'ada@test.com',
        phone: '08012345678',
        role: 'user',
        accountType: 'user',
        kycLevel: 2,
        pushToken: 'ExponentPushToken-11111111-aaaa-bbbb-cccc-222222222222',
    };
    const PURCHASE_SERVICE = {
        _id: new mongoose.Types.ObjectId(),
        code: 'TEST_AIRTIME',
        category: 'airtime',
        provider: 'VTPass',
    };
    const PURCHASE_OFFER = {
        _id: new mongoose.Types.ObjectId(),
        serviceId: PURCHASE_SERVICE._id,
        providerId: { _id: new mongoose.Types.ObjectId(), name: 'VTPass' },
        providerCode: 'test-airtime',
        costPrice: 0,
    };
    User.findById = function () {
        const helper = (fields) => ({
            lean: async () => {
                const out = {};
                String(fields).split(' ').forEach(f => { if (FULL_USER[f] !== undefined) out[f] = FULL_USER[f]; });
                return out;
            },
            then: (cb) => Promise.resolve(cb(FULL_USER)),
            catch: () => Promise.resolve(FULL_USER),
        });
        return {
            select: (fields) => helper(fields),
            session: async () => FULL_USER,
            lean: async () => FULL_USER,
            then: (cb) => Promise.resolve(cb(FULL_USER)),
            catch: () => Promise.resolve(FULL_USER),
        };
    };
    Setting.find = async () => [];
    // Legacy pricing (`getProviderCost`) queries Setting.findOne; stub it so the
    // real pricing fallback resolves offline instead of buffering on Mongoose.
    const mockSettingChain = (val) => ({
        session: () => mockSettingChain(val),
        lean: () => mockSettingChain(val),
        then: (cb) => Promise.resolve(cb(val)),
        catch: () => Promise.resolve(val),
    });
    Setting.findOne = () => mockSettingChain(null);

    // Channel spies (leaf methods of the service singleton)
    notificationService.sendPush = async () => { pushCount++; };
    notificationService.sendEmail = async () => { emailCount++; };
    notificationService.sendSMS = async () => { smsCount++; };

    // Microtask flush: the push fires fire-and-forget inside _pushToUser,
    // so counters can lag one microtask behind the awaited call.
    const flush = () => new Promise(r => setTimeout(r, 10));

    const NOTIFY_USER = {
        _id: FULL_USER._id,
        name: 'Ada Test',
        email: 'ada@test.com',
        phone: '08012345678',
    };
    const evtPayload = (eventKey) => ({
        title: 'Purchase Successful',
        message: 'Your top-up was successful.',
        smsMessage: 'Your purchase was successful.',
        emailSubject: 'Your purchase',
        emailHtml: '<p>Your purchase was successful.</p>',
        type: 'transaction',
        activityType: 'purchase_success',
        eventKey,
    });
    const countInAppFor = (key) => createdRecords.filter(r => r.eventKey === key).length;
    const flushAndSnapshot = async () => {
        await flush();
        return { push: pushCount, email: emailCount, sms: smsCount };
    };

    // Purchase-flow mocks (used by the referral ordering tests)
    let sessionCommitted = false;
    let sessionAborted = false;
    const baseSession = () => ({
        startTransaction: () => {},
        commitTransaction: async () => { sessionCommitted = true; },
        abortTransaction: async () => { sessionAborted = true; },
        endSession: () => {},
        inTransaction: () => true,
    });
    mongoose.startSession = async () => baseSession();
    pinService.verifyPin = async () => true;
    Service.findOne = async () => null;
    ServiceIdentity.findOne = async () => null;
    Wallet.findOne = async () => ({ balance: 50000 });
    walletService.debit = async () => true;
    Expense.create = async () => [];
    pricing.getProviderCost = async (serviceId, amount) => Math.round(amount * 0.98);
    pricing.calculateServicePrice = async (user, amount) => amount;
    pricingService.resolvePricing = async (user, service, offer, amount) => ({
        baseCostPrice: Math.round(Number(amount) * 0.98),
        salePrice: Number(amount),
        quantity: 1,
    });
    procurementService.selectBestOffer = async () => PURCHASE_OFFER;
    auditController.logAction = async () => {};

    const purchaseTransactions = [];
    Transaction.findById = id => ({
        session: async () => purchaseTransactions.find(tx => String(tx._id) === String(id)) || null,
        then: (resolve, reject) => Promise.resolve(purchaseTransactions.find(tx => String(tx._id) === String(id)) || null).then(resolve, reject),
    });
    Transaction.updateOne = async (filter, update) => {
        const tx = purchaseTransactions.find(item => String(item._id) === String(filter._id));
        if (!tx) return { modifiedCount: 0 };
        if (update.$set) Object.assign(tx, update.$set);
        return { modifiedCount: 1 };
    };
    Transaction.findOneAndUpdate = async (filter, update) => {
        const tx = purchaseTransactions.find(item => String(item._id) === String(filter._id)
            && item.status === filter.status
            && item.isLoss === filter.isLoss
            && item.providerOutcome === filter.providerOutcome
            && item.resolutionState !== 'finalizing');
        if (!tx) return null;
        if (update.$set) Object.assign(tx, update.$set);
        return tx;
    };

    const mockRes = () => ({
        _status: null,
        _json: null,
        status(code) { this._status = code; return this; },
        json(payload) { this._json = payload; return this; },
    });

    const mockPendingProcessingClaim = (doc, calls) => async (filter, update, options = {}) => {
        calls.push({ filter, update, options });
        if (String(filter._id) !== String(doc._id) || filter.status !== doc.status) return null;
        const previous = { ...doc };
        Object.assign(doc, update.$set || {});
        return options.new ? doc : previous;
    };

    try {
        // ═════════════════════════════════════════════════════════
        // PHASE A — FAN-OUT DEDUP LIFECYCLE (service-level)
        // ═════════════════════════════════════════════════════════

        await test('A1. Sequential duplicate eventKey: 1 in-app, 1 push, 1 email, 1 SMS, then no-op', async () => {
            resetDedupState();
            const key = 'purchase_success:ZNT-A1';

            const r1 = await notificationService.notify(NOTIFY_USER, evtPayload(key));
            await flush();
            assert.strictEqual(r1, undefined, 'first dispatch succeeds (notify resolves silently)');
            assert.strictEqual(countInAppFor(key), 1, 'one in-app record created');
            assert.strictEqual(pushCount, 1, 'one push');
            assert.strictEqual(emailCount, 1, 'one email');
            assert.strictEqual(smsCount, 1, 'one SMS');

            const r2 = await notificationService.notify(NOTIFY_USER, evtPayload(key));
            await flush();
            assert.ok(r2 && r2.deduplicated === true, 'duplicate dispatch returns { deduplicated: true }');
            assert.strictEqual(countInAppFor(key), 1, 'no second in-app record');
            assert.strictEqual(pushCount, 1, 'no second push');
            assert.strictEqual(emailCount, 1, 'no second email');
            assert.strictEqual(smsCount, 1, 'no second SMS');
        });

        await test('A2. Different references never collide (no spurious dedup)', async () => {
            resetDedupState();
            await notificationService.notify(NOTIFY_USER, evtPayload('purchase_success:ZNT-A2-1'));
            await notificationService.notify(NOTIFY_USER, evtPayload('purchase_success:ZNT-A2-2'));
            await flush();
            assert.strictEqual(createdRecords.length, 2, 'two distinct in-app records');
            assert.strictEqual(pushCount, 2, 'two pushes');
            assert.strictEqual(emailCount, 2, 'two emails');
            assert.strictEqual(smsCount, 2, 'two SMS');
        });

        await test('A3. Concurrent duplicate eventKey resolves to exactly one fan-out (index-backstopped)', async () => {
            resetDedupState();
            const key = 'purchase_success:ZNT-A3-CONCURRENT';

            const [ra, rb] = await Promise.all([
                notificationService.notify(NOTIFY_USER, evtPayload(key)),
                notificationService.notify(NOTIFY_USER, evtPayload(key)),
            ]);
            await flush();

            const results = [ra, rb];
            assert.strictEqual(results.filter(r => r === undefined).length, 1, 'exactly one caller wins');
            assert.strictEqual(results.filter(r => r && r.deduplicated === true).length, 1, 'exactly one caller is deduplicated');
            assert.strictEqual(countInAppFor(key), 1, 'exactly one in-app record');
            assert.strictEqual(pushCount, 1, 'exactly one push');
            assert.strictEqual(emailCount, 1, 'exactly one email');
            assert.strictEqual(smsCount, 1, 'exactly one SMS');
        });

        await test('A4. E11000 create conflict is suppressed without throwing and without fan-out', async () => {
            resetDedupState();
            const origFindOne = Notification.findOne;
            const origCreate = Notification.create;
            Notification.findOne = () => ({ lean: async () => null });
            Notification.create = async () => {
                const err = new Error('E11000 duplicate key error collection: notifications');
                err.code = 11000;
                throw err;
            };
            try {
                const result = await notificationService.sendInApp(
                    FULL_USER._id,
                    { title: 'T', message: 'M', type: 'transaction', metadata: {} },
                    'purchase_success:ZNT-A4'
                );
                await flush();
                assert.strictEqual(result, null, '_createEventDeduped returns null on 11000');
                assert.strictEqual(pushCount, 0, 'no push after a suppressed duplicate');
                assert.strictEqual(emailCount, 0, 'no email after a suppressed duplicate');
                assert.strictEqual(smsCount, 0, 'no SMS after a suppressed duplicate');
            } finally {
                Notification.findOne = origFindOne;
                Notification.create = origCreate;
            }
        });

        await test('A5. sendFundingSuccess dedups by reference: 1 in-app/1 push/1 email/0 SMS', async () => {
            resetDedupState();
            const ref = 'ZNT-FUND-DUP-1';

            const r1 = await notificationService.sendFundingSuccess({
                userId: FULL_USER._id, amount: 5000, method: 'Bank Transfer', reference: ref, type: 'funding',
            });
            await flush();
            assert.strictEqual(r1.dispatched, true, 'first funding dispatch succeeds');
            assert.strictEqual(countInAppFor(`funding_success:${ref}`), 1, 'one funding in-app record');
            assert.strictEqual(pushCount, 1, 'one push');
            assert.strictEqual(emailCount, 1, 'one email');
            assert.strictEqual(smsCount, 0, 'funding NEVER sends SMS');

            const r2 = await notificationService.sendFundingSuccess({
                userId: FULL_USER._id, amount: 5000, method: 'Bank Transfer', reference: ref, type: 'funding',
            });
            await flush();
            assert.ok(r2.deduplicated === true, 'duplicate funding reference is a no-op');
            assert.strictEqual(countInAppFor(`funding_success:${ref}`), 1);
            assert.strictEqual(pushCount, 1, 'no second push');
            assert.strictEqual(emailCount, 1, 'no second email');
        });

        await test('A6. SendFundingSuccess (investment_buy) never emails, still pushes', async () => {
            resetDedupState();
            const r = await notificationService.sendFundingSuccess({
                userId: FULL_USER._id, amount: 10000, method: 'Bank Transfer', reference: 'ZNT-FUND-INV-1', type: 'investment_buy',
            });
            await flush();
            assert.ok(r.dispatched === true);
            assert.strictEqual(countInAppFor('investment_buy_success:ZNT-FUND-INV-1'), 1);
            assert.strictEqual(pushCount, 1, 'one push');
            assert.strictEqual(emailCount, 0, 'no email for share purchases');
            assert.strictEqual(smsCount, 0, 'no SMS for funding');
        });

        await test('A7. sendFundingAdvisory (failed) dedups and NEVER emails or SMSes', async () => {
            resetDedupState();
            const ref = 'ZNT-ADV-1';
            const r1 = await notificationService.sendFundingAdvisory(FULL_USER._id, { kind: 'failed', amount: 2000, reference: ref });
            await flush();
            assert.ok(r1.dispatched === true);
            assert.strictEqual(countInAppFor(`funding_failed:${ref}`), 1);
            assert.strictEqual(pushCount, 1);
            assert.strictEqual(emailCount, 0, 'advisory never emails');
            assert.strictEqual(smsCount, 0, 'advisory never SMSes');

            const r2 = await notificationService.sendFundingAdvisory(FULL_USER._id, { kind: 'failed', amount: 2000, reference: ref });
            await flush();
            assert.ok(r2.deduplicated === true, 'repeat advisory is a no-op');
            assert.strictEqual(pushCount, 1, 'no second push');
        });

        await test('A8. notifyReferralEarned full fan-out (1 in-app/1 push/1 email/1 SMS) then dedups', async () => {
            resetDedupState();
            const ref = 'TXN-PARENT-A8';
            const intent = {
                userId: FULL_USER._id,
                email: FULL_USER.email,
                phone: FULL_USER.phone,
                buyerLabel: 'Ada',
                service: 'airtime',
                commission: 50,
                commId: `COMM-${ref}`,
                eventKey: `referral_commission:${ref}`,
            };

            const r1 = await notificationService.notifyReferralEarned(intent);
            await flush();
            assert.ok(r1 === undefined || r1 === true || (r1 && r1.deduplicated === undefined), 'referral dispatch succeeds');
            assert.strictEqual(countInAppFor(`referral_commission:${ref}`), 1, 'one referral in-app record');
            assert.strictEqual(pushCount, 1, 'one push');
            assert.strictEqual(emailCount, 1, 'one email');
            assert.strictEqual(smsCount, 1, 'one SMS');

            const r2 = await notificationService.notifyReferralEarned(intent);
            await flush();
            assert.ok(r2 && r2.deduplicated === true, 'duplicate referral event is a no-op');
            assert.strictEqual(pushCount, 1, 'no second push');
            assert.strictEqual(emailCount, 1, 'no second email');
            assert.strictEqual(smsCount, 1, 'no second SMS');
        });

        await test('A9. Legacy path without eventKey is byte-for-byte repeated (no dedup)', async () => {
            resetDedupState();
            const payload = {
                title: 'Legacy Notice',
                message: 'Legacy message body',
                smsMessage: 'Legacy SMS',
                emailSubject: 'Legacy',
                emailHtml: '<p>legacy</p>',
                type: 'system',
                activityType: null,
            };
            const r1 = await notificationService.notify(NOTIFY_USER, payload);
            const r2 = await notificationService.notify(NOTIFY_USER, payload);
            await flush();
            assert.strictEqual(r1, undefined, 'legacy first dispatch resolves');
            assert.strictEqual(r2, undefined, 'legacy second dispatch resolves (no dedup flag)');
            assert.strictEqual(createdRecords.length, 2, 'two in-app records');
            assert.strictEqual(pushCount, 2, 'two pushes');
            assert.strictEqual(emailCount, 2, 'two emails');
            assert.strictEqual(smsCount, 2, 'two SMS');
        });

        await test('A10. Non-11000 DB failure suppresses all channels and never throws', async () => {
            resetDedupState();
            const origFindOne = Notification.findOne;
            const origCreate = Notification.create;
            Notification.findOne = () => ({ lean: async () => null });
            Notification.create = async () => { throw new Error('Mongo server selection timeout'); };
            try {
                const r = await notificationService.sendFundingSuccess({
                    userId: FULL_USER._id, amount: 3000, method: 'Bank Transfer', reference: 'ZNT-DBFAIL-1', type: 'funding',
                });
                await flush();
                assert.ok(r && r.deduplicated === true, 'DB failure is treated as a suppressed delivery');
                assert.strictEqual(pushCount, 0, 'push suppressed');
                assert.strictEqual(emailCount, 0, 'email suppressed');
                assert.strictEqual(smsCount, 0, 'sms suppressed');

                const rn = await notificationService.notify(NOTIFY_USER, evtPayload('purchase_success:ZNT-DBFAIL-1'));
                await flush();
                assert.ok(rn && rn.deduplicated === true, 'notify path also suppresses channels on DB failure');
                assert.strictEqual(pushCount, 0, 'no push in notify path');
                assert.strictEqual(emailCount, 0, 'no email in notify path');
                assert.strictEqual(smsCount, 0, 'no SMS in notify path');
            } finally {
                Notification.findOne = origFindOne;
                Notification.create = origCreate;
            }
        });

        // ═════════════════════════════════════════════════════════
        // PHASE B — AFTER-COMMIT ORDERING (integration)
        // ═════════════════════════════════════════════════════════

        const referralNotifies = [];
        const purchaseSuccessNotifies = [];
        notificationService.notifyReferralEarned = async (intent) => {
            referralNotifies.push({ intent, committedAtDispatch: sessionCommitted });
        };
        notificationService.notifyPurchaseSuccess = async () => {
            purchaseSuccessNotifies.push({ committedAtDispatch: sessionCommitted });
        };

        await test('B1. Referral-earned notify dispatches AFTER parent commit, with intent and correct commission', async () => {
            sessionCommitted = false;
            sessionAborted = false;
            referralNotifies.length = 0;
            purchaseSuccessNotifies.length = 0;
            let savedTx = null;

            Transaction.create = async (doc) => {
                savedTx = {
                    ...doc,
                    _id: new mongoose.Types.ObjectId(),
                    transactionId: 'TXN-REF-1',
                    isLoss: Boolean(doc.isLoss),
                    resolutionState: doc.resolutionState || 'unresolved',
                    save: async function () { return this; },
                };
                purchaseTransactions.push(savedTx);
                return savedTx;
            };

            referral.processLifetimeCommission = async (userId, amount, parentTxnId, parentTxnStringId) => ({
                commission: 50,
                notificationIntent: {
                    userId,
                    email: 'ref@test.com',
                    phone: '08099999999',
                    buyerLabel: 'Ada Test',
                    service: 'airtime',
                    commission: 50,
                    commId: `COMM-${parentTxnStringId}`,
                    eventKey: `referral_commission:${parentTxnStringId}`,
                },
            });

            const result = await purchaseService.processPurchase(FULL_USER._id, {
                type: 'airtime',
                serviceId: 'mtn',
                canonicalService: PURCHASE_SERVICE,
                amount: 5000,
                pin: '1234',
                details: { request_id: 'ZNT-REF-ORDER-1', phone: '08012345678' },
                providerCall: async () => ({
                    success: true, status: 'success',
                    message: 'Airtime delivered', transactionId: 'VTP-AIR-REF1',
                    raw: { code: '000' },
                }),
            });

            assert.strictEqual(result.success, true, 'purchase succeeds');
            assert.strictEqual(referralNotifies.length, 1, 'exactly one referral notification intent is dispatched');
            assert.strictEqual(referralNotifies[0].committedAtDispatch, true, 'dispatch happens only AFTER commitTransaction');
            assert.strictEqual(referralNotifies[0].intent.eventKey, 'referral_commission:TXN-REF-1', 'intent eventKey carries the parent transaction identity');
            assert.strictEqual(referralNotifies[0].intent.commission, 50, 'intent carries the credited commission');
            assert.strictEqual(purchaseSuccessNotifies.length, 1, 'purchase success notified once');
            assert.strictEqual(savedTx.netProfitAfterCommission, 50, 'netProfitAfterCommission = profit(100) - commission(50)');
        });

        await test('B2. Referral/purchase notifications are NEVER dispatched when commit rolls back', async () => {
            sessionCommitted = false;
            sessionAborted = false;
            referralNotifies.length = 0;
            purchaseSuccessNotifies.length = 0;

            referral.processLifetimeCommission = async (userId, amount, parentTxnId, parentTxnStringId) => ({
                commission: 50,
                notificationIntent: {
                    userId, email: 'ref@test.com', phone: '08099999999',
                    buyerLabel: 'Ada Test', service: 'airtime', commission: 50,
                    commId: `COMM-${parentTxnStringId}`, eventKey: `referral_commission:${parentTxnStringId}`,
                },
            });

            mongoose.startSession = async () => ({
                ...baseSession(),
                commitTransaction: async () => { throw new Error('COMMIT_FAILED'); },
            });

            const result = await purchaseService.processPurchase(FULL_USER._id, {
                type: 'airtime',
                serviceId: 'mtn',
                canonicalService: PURCHASE_SERVICE,
                amount: 5000,
                pin: '1234',
                details: { request_id: 'ZNT-REF-ROLLBACK-1', phone: '08012345678' },
                providerCall: async () => ({
                    success: true, status: 'success',
                    message: 'Airtime delivered', transactionId: 'VTP-AIR-RB1',
                }),
            });

            mongoose.startSession = async () => baseSession();

            assert.strictEqual(result.status, 'pending', 'provider success remains unresolved when local commit fails');
            assert.strictEqual(sessionAborted, true, 'transaction is aborted on rollback');
            assert.strictEqual(referralNotifies.length, 0, 'zero referral notifications after rollback');
            assert.strictEqual(purchaseSuccessNotifies.length, 0, 'zero success notifications after rollback');
        });

        // Investment admin flows — dispatch must follow a committed transaction.
        const { processShareExit, processDividendWithdrawal } = require('../controllers/investmentController');
        const investmentOrder = [];
        const walletCredits = [];
        const uid = new mongoose.Types.ObjectId();
        notificationService.sendInApp = async (userId, payload, eventKey) => {
            investmentOrder.push({ committed: sessionCommitted, eventKey, payload });
        };
        walletService.credit = async (...args) => {
            walletCredits.push(args);
            return { balance: 119000 };
        };

        await test('B3. processShareExit (approved) notifies only AFTER commit, with proper eventKey+payload', async () => {
            sessionCommitted = false;
            sessionAborted = false;
            investmentOrder.length = 0;
            walletCredits.length = 0;
            const exitId = 'EXTID001';
            const claimCalls = [];
            const exitRequest = {
                _id: exitId, userId: uid, sharesRequested: 2, sharePrice: 10000,
                grossAmount: 20000, exitFeePercent: 5, exitFeeCharged: 1000, netAmount: 19000,
                reservationVersion: 1, reservedShares: 2,
                firstPurchasedAt: new Date('2024-01-01T00:00:00.000Z'), lockPeriodMonths: 6,
                lockExpiresAt: new Date('2024-07-01T00:00:00.000Z'),
                status: 'pending', refId: 'EXIT-REF-1', save: async () => {},
            };
            ShareExitRequest.findOneAndUpdate = mockPendingProcessingClaim(exitRequest, claimCalls);
            const shareUserDoc = { _id: uid, name: 'Ada', sharesOwned: 5, frozenShares: 2, isShareholder: true, save: async () => {} };
            User.findById = () => ({
                session: () => Promise.resolve(shareUserDoc),
                then: (cb) => Promise.resolve(cb(shareUserDoc)),
            });
            Transaction.create = async () => [];
            let callerSession;
            mongoose.startSession = async () => {
                callerSession = baseSession();
                return callerSession;
            };

            const res = mockRes();
            await processShareExit(
                { params: { id: exitId }, body: { action: 'approved', adminNote: 'ok' }, user: { id: 'adm1', name: 'Admin' } },
                res
            );

            assert.strictEqual(res._json.success, true, 'share exit approved');
            assert.strictEqual(claimCalls.length, 1, 'pending exit is claimed exactly once');
            assert.deepStrictEqual(claimCalls[0].filter, { _id: exitId, status: 'pending' });
            assert.deepStrictEqual(claimCalls[0].update, { $set: { status: 'processing' } });
            assert.strictEqual(claimCalls[0].options.new, true, 'claim returns the processing record');
            assert.strictEqual(claimCalls[0].options.session, callerSession, 'claim uses the caller transaction');
            assert.strictEqual(walletCredits.length, 1, 'approved exit creates one wallet ledger credit');
            assert.strictEqual(walletCredits[0][1], 19000, 'wallet credit uses the validated net amount');
            assert.strictEqual(walletCredits[0][5], callerSession, 'wallet credit uses the caller transaction');
            assert.strictEqual(investmentOrder.length, 1, 'exactly one notification');
            assert.strictEqual(investmentOrder[0].committed, true, 'dispatch happens only AFTER commitTransaction');
            assert.strictEqual(investmentOrder[0].eventKey, `share_exit_approved:${exitId}`, 'eventKey carries the exit request id + action');
            assert.strictEqual(investmentOrder[0].payload.type, 'investment');
        });

        await test('B4. processShareExit never notifies when the commit rolls back', async () => {
            sessionCommitted = false;
            sessionAborted = false;
            investmentOrder.length = 0;
            walletCredits.length = 0;

            const exitRequest = {
                _id: 'EXTID001', userId: uid, sharesRequested: 2, sharePrice: 10000,
                grossAmount: 20000, exitFeePercent: 5, exitFeeCharged: 1000, netAmount: 19000,
                reservationVersion: 1, reservedShares: 2,
                firstPurchasedAt: new Date('2024-01-01T00:00:00.000Z'), lockPeriodMonths: 6,
                lockExpiresAt: new Date('2024-07-01T00:00:00.000Z'),
                status: 'pending', refId: 'EXIT-REF-ROLLBACK', save: async () => {},
            };
            const claimCalls = [];
            ShareExitRequest.findOneAndUpdate = mockPendingProcessingClaim(exitRequest, claimCalls);
            const shareUserDoc = { _id: uid, name: 'Ada', sharesOwned: 5, frozenShares: 2, isShareholder: true, save: async () => {} };
            User.findById = () => ({
                session: () => Promise.resolve(shareUserDoc),
                then: (cb) => Promise.resolve(cb(shareUserDoc)),
            });

            const rollbackSession = {
                ...baseSession(),
                commitTransaction: async () => { throw new Error('COMMIT_FAILED'); },
            };
            mongoose.startSession = async () => rollbackSession;

            const res = mockRes();
            await processShareExit(
                { params: { id: 'EXTID001' }, body: { action: 'approved', adminNote: 'ok' }, user: { id: 'adm1', name: 'Admin' } },
                res
            );

            mongoose.startSession = async () => baseSession();

            assert.strictEqual(investmentOrder.length, 0, 'zero notifications after rollback');
            assert.strictEqual(sessionAborted, true, 'share exit transaction is aborted on rollback');
            assert.strictEqual(claimCalls.length, 1, 'rollback path claimed the pending exit');
            assert.strictEqual(walletCredits.length, 1, 'wallet credit was attempted inside the transaction');
            assert.strictEqual(walletCredits[0][5], rollbackSession, 'rolled-back credit used the caller transaction');
            assert.strictEqual(res._status, 500, 'admin sees an error, not a false success');
        });

        await test('B5. processDividendWithdrawal (approved) notifies only AFTER commit, no superadmin spam under 50k', async () => {
            sessionCommitted = false;
            sessionAborted = false;
            investmentOrder.length = 0;
            const wId = 'WID001';
            const claimCalls = [];
            const withdrawalApprovedDoc = {
                _id: wId, userId: uid, amount: 20000, netAmount: 19700, feeCharged: 300,
                feePercent: 1.5, source: 'dividend', reservationVersion: 1,
                reservedAmountKobo: 2000000, reservedSource: 'dividend',
                status: 'pending', refId: 'DIVW-1', bankName: 'GTB',
                accountNumber: '0123456789', accountName: 'Ada Test', save: async () => {},
            };

            InvestmentWithdrawal.findOneAndUpdate = mockPendingProcessingClaim(withdrawalApprovedDoc, claimCalls);
            User.findById = () => ({ session: () => Promise.resolve({ dividendBalance: 50000, save: async () => {} }) });
            Transaction.create = async () => [];
            let callerSession;
            mongoose.startSession = async () => {
                callerSession = baseSession();
                return callerSession;
            };

            const res = mockRes();
            await processDividendWithdrawal(
                { params: { id: wId }, body: { action: 'approved', adminNote: 'ok' }, user: { id: 'adm1', name: 'Admin' } },
                res
            );

            assert.strictEqual(res._json.success, true, 'withdrawal approved');
            assert.strictEqual(claimCalls.length, 1, 'pending withdrawal is claimed exactly once');
            assert.deepStrictEqual(claimCalls[0].filter, { _id: wId, status: 'pending' });
            assert.deepStrictEqual(claimCalls[0].update, { $set: { status: 'processing' } });
            assert.strictEqual(claimCalls[0].options.new, true, 'claim returns the processing record');
            assert.strictEqual(claimCalls[0].options.session, callerSession, 'claim uses the caller transaction');
            assert.strictEqual(investmentOrder.length, 1, 'exactly one notification');
            assert.strictEqual(investmentOrder[0].committed, true, 'dispatch happens only AFTER commitTransaction');
            assert.strictEqual(investmentOrder[0].eventKey, `dividend_withdrawal_approved:${wId}`, 'eventKey carries withdrawal id + action');
            assert.strictEqual(investmentOrder[0].payload.type, 'investment');
            assert.ok(investmentOrder[0].payload.message.includes('approved'), 'message reflects the approved state');
        });

        await test('B6. processDividendWithdrawal (rejected) notifies after commit and refunds dividend balance', async () => {
            sessionCommitted = false;
            sessionAborted = false;
            investmentOrder.length = 0;
            const wId = 'WID002';
            let capturedUser = null;
            const claimCalls = [];
            const withdrawalRejectedDoc = {
                _id: wId, userId: uid, amount: 20000, netAmount: 19700, feeCharged: 300,
                feePercent: 1.5, source: 'dividend', reservationVersion: 1,
                reservedAmountKobo: 2000000, reservedSource: 'dividend',
                status: 'pending', refId: 'DIVW-2', bankName: 'GTB',
                accountNumber: '0123456789', accountName: 'Ada Test', save: async () => {},
            };

            InvestmentWithdrawal.findOneAndUpdate = mockPendingProcessingClaim(withdrawalRejectedDoc, claimCalls);
            User.findById = () => {
                capturedUser = { dividendBalance: 50000, save: async () => {} };
                return {
                    session: () => Promise.resolve(capturedUser),
                    then: (cb) => Promise.resolve(cb(capturedUser)),
                };
            };
            Transaction.create = async () => [];
            let callerSession;
            mongoose.startSession = async () => {
                callerSession = baseSession();
                return callerSession;
            };

            const res = mockRes();
            await processDividendWithdrawal(
                { params: { id: wId }, body: { action: 'rejected', adminNote: 'fraud review' }, user: { id: 'adm1', name: 'Admin' } },
                res
            );

            assert.strictEqual(res._json.success, true, 'withdrawal rejected');
            assert.strictEqual(claimCalls.length, 1, 'pending withdrawal is claimed exactly once');
            assert.strictEqual(claimCalls[0].options.session, callerSession, 'claim uses the caller transaction');
            assert.strictEqual(capturedUser.dividendBalance, 70000, 'rejected withdrawal amount is refunded to dividend balance');
            assert.strictEqual(investmentOrder.length, 1, 'exactly one notification');
            assert.strictEqual(investmentOrder[0].committed, true, 'dispatch happens only AFTER commitTransaction');
            assert.strictEqual(investmentOrder[0].eventKey, `dividend_withdrawal_rejected:${wId}`, 'eventKey carries action=rejected');
            assert.ok(investmentOrder[0].payload.message.includes('rejected'), 'message reflects the rejected state');
            assert.ok(investmentOrder[0].payload.message.includes('fraud review'), 'admin note surfaces in the rejection message');
        });

    } finally {
        // Restore every mock to its original reference
        Notification.findOne = O.NF;
        Notification.create = O.NC;
        User.findById = O.UF;
        Setting.find = O.SF;
        Setting.findOne = O.SF1;
        notificationService.sendPush = O.sendPush;
        notificationService.sendEmail = O.sendEmail;
        notificationService.sendSMS = O.sendSMS;
        notificationService.sendInApp = O.sendInApp;
        notificationService.notifyReferralEarned = O.notifyReferralEarned;
        notificationService.notifyPurchaseSuccess = O.notifyPurchaseSuccess;
        mongoose.startSession = O.startSession;
        referral.processLifetimeCommission = O.processLifetimeCommission;
        pinService.verifyPin = O.verifyPin;
        Service.findOne = O.ServiceFindOne;
        ServiceIdentity.findOne = O.ServiceIdentityFindOne;
        Wallet.findOne = O.WalletFindOne;
        walletService.credit = O.walletCredit;
        walletService.debit = O.walletDebit;
        Transaction.create = O.TransactionCreate;
        Transaction.findById = O.TransactionFindById;
        Transaction.findOneAndUpdate = O.TransactionFindOneAndUpdate;
        Transaction.updateOne = O.TransactionUpdateOne;
        Expense.create = O.ExpenseCreate;
        pricing.getProviderCost = O.getProviderCost;
        pricing.calculateServicePrice = O.calculateServicePrice;
        pricingService.resolvePricing = O.resolvePricing;
        procurementService.selectBestOffer = O.selectBestOffer;
        auditController.logAction = O.logAction;
        ShareExitRequest.findById = O.ShareExitFindById;
        ShareExitRequest.findOneAndUpdate = O.ShareExitFindOneAndUpdate;
        InvestmentWithdrawal.findById = O.InvestmentWithdrawalFindById;
        InvestmentWithdrawal.findOneAndUpdate = O.InvestmentWithdrawalFindOneAndUpdate;
    }

    console.log('\n----------------------------------------------------');
    console.log(`Test Execution Finished: ${passed} PASSED, ${failed} FAILED.`);
    console.log('----------------------------------------------------\n');

    process.exit(failed > 0 ? 1 : 0);
}

runNotificationDedupTests();
