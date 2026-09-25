const assert = require('assert');
const mongoose = require('mongoose');
const axios = require('axios');

const VTPassAdapter = require('../adapters/vtpass.adapter');
const Vas2NetsAdapter = require('../adapters/vas2nets.adapter');
const UniversalAdapter = require('../adapters/universal.adapter');
const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const User = require('../models/User');
const Expense = require('../models/Expense');
const WalletLedger = require('../models/WalletLedger');
const Notification = require('../models/Notification');
const SmsDelivery = require('../models/SmsDelivery');
const purchaseService = require('../services/purchase.service');
const notificationService = require('../services/notification.service');
const walletService = require('../services/wallet.service');
const pinService = require('../services/pin.service');
const pricingService = require('../services/pricing.service');
const procurementService = require('../services/procurement.service');
const referral = require('../utils/referral');
const transactionController = require('../controllers/transactionController');
const {
    normalizeFulfillment,
    encryptFulfillment,
    decryptFulfillment,
    redactProviderEvidence,
} = require('../utils/fulfillment');
const { serializeCustomerTransaction } = require('../utils/customerTransactionSerializer');
const {
    buildPurchaseSuccessContent,
    buildCredentialSmsBatches,
} = require('../utils/notificationFormatter');

async function run() {
    let passed = 0;
    let failed = 0;
    async function test(name, fn) {
        try {
            await fn();
            console.log(`[PASS] ${name}`);
            passed++;
        } catch (error) {
            console.error(`[FAIL] ${name}`);
            console.error(`  ${error.stack || error.message}`);
            failed++;
        }
    }

    console.log('====================================================');
    console.log(' PIN/TOKEN NORMALIZATION, STORAGE & DELIVERY TESTS');
    console.log('====================================================\n');

    await test('1. VTPass normalizes one electricity token', () => {
        const adapter = new VTPassAdapter({ baseUrl: 'https://provider.test' });
        const result = adapter.mapResponse({ code: '000', purchased_code: 'Token: 1111-2222' });
        assert.deepStrictEqual(result.fulfillment, { items: [{ code: '1111-2222', serial: null }] });
        assert.strictEqual(result.token, '1111-2222');
    });

    await test('2. Vas2Nets normalizes one exam PIN', () => {
        const adapter = new Vas2NetsAdapter({ baseUrl: 'https://provider.test' });
        const result = adapter.mapResponse({ code: '000', status: 'success', pin: 'PIN-ONE' });
        assert.deepStrictEqual(result.fulfillment.items, [{ code: 'PIN-ONE', serial: null }]);
    });

    await test('3. Universal preserves multiple exam PINs in provider order', () => {
        const adapter = new UniversalAdapter({
            baseUrl: 'https://provider.test',
            metadata: { successPath: 'status', successValue: 'success' },
        });
        const result = adapter.mapResponse({ status: 'success', pins: ['PIN-1', 'PIN-2', 'PIN-3'] });
        assert.deepStrictEqual(result.fulfillment.items.map(item => item.code), ['PIN-1', 'PIN-2', 'PIN-3']);
        assert.strictEqual(result.token, 'PIN-1');
    });

    await test('4. PIN and serial pairs are preserved without invented serials', () => {
        const fulfillment = normalizeFulfillment({
            tokens: [
                { pin: 'PIN-A', serial_number: 'SER-A' },
                { pin: 'PIN-B' },
            ],
        });
        assert.deepStrictEqual(fulfillment.items, [
            { code: 'PIN-A', serial: 'SER-A' },
            { code: 'PIN-B', serial: null },
        ]);
        assert.deepStrictEqual(normalizeFulfillment({
            purchased_code: 'Serial No: SER-TEXT, Pin: PIN-TEXT',
        }).items, [{ code: 'PIN-TEXT', serial: 'SER-TEXT' }]);
    });

    await test('5. encrypted fulfillment round-trips without plaintext storage', () => {
        const encrypted = encryptFulfillment(
            { items: [{ code: 'SECRET-PIN', serial: 'SECRET-SERIAL' }] },
            { expectedQuantity: 1, complete: true }
        );
        const persisted = JSON.stringify(encrypted);
        assert.ok(!persisted.includes('SECRET-PIN'));
        assert.ok(!persisted.includes('SECRET-SERIAL'));
        assert.match(encrypted.items[0].code, /^enc:v1:/);
        assert.deepStrictEqual(decryptFulfillment(encrypted).items, [
            { code: 'SECRET-PIN', serial: 'SECRET-SERIAL' },
        ]);
    });

    await test('6. provider evidence redaction removes credentials from nested raw data and messages', () => {
        const fulfillment = { items: [{ code: 'PIN-RAW-1', serial: 'SER-RAW-1' }] };
        const redacted = redactProviderEvidence({
            message: 'Delivered PIN-RAW-1 / SER-RAW-1',
            raw: { token: 'PIN-RAW-1', serial_number: 'SER-RAW-1', status: 'success' },
        }, fulfillment);
        const persisted = JSON.stringify(redacted);
        assert.ok(!persisted.includes('PIN-RAW-1'));
        assert.ok(!persisted.includes('SER-RAW-1'));
        assert.strictEqual(redacted.raw.status, 'success');

        const numericSource = { content: { transactions: [{ code: 12345678 }] } };
        const numericFulfillment = { items: [{ code: '12345678', serial: null }] };
        const numericRedacted = redactProviderEvidence(numericSource, numericFulfillment);
        assert.strictEqual(JSON.stringify(numericRedacted).includes('12345678'), false);
    });

    const encryptedPins = encryptFulfillment({
        items: [
            { code: 'PIN-OWNER-1', serial: 'SER-OWNER-1' },
            { code: 'PIN-OWNER-2', serial: null },
        ],
    }, { expectedQuantity: 2, complete: true });
    const encryptedToken = encryptFulfillment({
        items: [{ code: 'TOKEN-OWNER', serial: null }],
    }, { expectedQuantity: 1, complete: true });

    await test('7. transaction type pin exposes all authorized fulfillment items', () => {
        const dto = serializeCustomerTransaction({
            _id: 'pin-tx', type: 'pin', status: 'success', fulfillment: encryptedPins,
            details: { serviceID: 'waec', quantity: 2 },
        });
        assert.deepStrictEqual(dto.details.fulfillment, [
            { code: 'PIN-OWNER-1', serial: 'SER-OWNER-1' },
            { code: 'PIN-OWNER-2', serial: null },
        ]);
    });

    await test('8. electricity receipt exposes its authorized token', () => {
        const dto = serializeCustomerTransaction({
            _id: 'electric-tx', type: 'electricity', status: 'success', fulfillment: encryptedToken,
            details: { meter_number: '12345678901', meter_type: 'prepaid' },
        });
        assert.strictEqual(dto.details.token, 'TOKEN-OWNER');
        assert.deepStrictEqual(dto.details.fulfillment, [{ code: 'TOKEN-OWNER', serial: null }]);
    });

    await test('9. customer transaction lookup remains owner-scoped and decrypts only for owner', async () => {
        const originalFindOne = Transaction.findOne;
        const originalLedgerFindOne = WalletLedger.findOne;
        const ownerId = new mongoose.Types.ObjectId();
        const otherId = new mongoose.Types.ObjectId();
        const txId = new mongoose.Types.ObjectId();
        const document = {
            _id: txId, userId: ownerId, transactionId: 'TX-OWNER', refId: 'REF-OWNER',
            type: 'pin', status: 'success', fulfillment: encryptedPins,
            details: { serviceID: 'waec', quantity: 2 },
        };
        Transaction.findOne = async filter => (
            String(filter.userId) === String(ownerId) && String(filter._id) === String(txId) ? document : null
        );
        WalletLedger.findOne = async () => null;
        const makeRes = () => ({
            statusCode: 200, body: null,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; },
        });
        try {
            const ownerRes = makeRes();
            await transactionController.getUserTransaction({ user: { id: ownerId }, params: { id: txId } }, ownerRes);
            assert.strictEqual(ownerRes.body.details.fulfillment[0].code, 'PIN-OWNER-1');

            const otherRes = makeRes();
            await transactionController.getUserTransaction({ user: { id: otherId }, params: { id: txId } }, otherRes);
            assert.strictEqual(otherRes.statusCode, 404);
            assert.strictEqual(JSON.stringify(otherRes.body).includes('PIN-OWNER-1'), false);
        } finally {
            Transaction.findOne = originalFindOne;
            WalletLedger.findOne = originalLedgerFindOne;
        }
    });

    await test('10. electricity credential appears only in SMS-specific content', () => {
        const content = buildPurchaseSuccessContent({
            type: 'electricity', serviceId: 'ikeja-electric', amount: 2000,
            reference: 'REF-ELECTRIC', details: { productName: 'Ikeja Electricity' },
            fulfillment: { items: [{ code: 'TOKEN-SMS-1', serial: null }], complete: true },
            brand: { siteName: 'Zantara' },
        });
        assert.ok(content.smsMessages[0].includes('Token: TOKEN-SMS-1'));
        assert.ok(!content.message.includes('TOKEN-SMS-1'));
        assert.ok(!content.emailHtml.includes('TOKEN-SMS-1'));
    });

    await test('11. exam PIN SMS uses product name and includes serial', () => {
        const content = buildPurchaseSuccessContent({
            type: 'pin', serviceId: 'WAEC_INTERNAL', amount: 4000,
            reference: 'REF-WAEC', details: { productName: 'WAEC Result Checker' },
            fulfillment: { items: [{ code: 'PIN-SMS-1', serial: 'SER-SMS-1' }], complete: true },
            brand: { siteName: 'Zantara' },
        });
        assert.match(content.smsMessages[0], /WAEC Result Checker/);
        assert.match(content.smsMessages[0], /PIN: PIN-SMS-1/);
        assert.match(content.smsMessages[0], /Serial: SER-SMS-1/);
        assert.ok(!content.message.includes('PIN-SMS-1'));
    });

    await test('12. multi-PIN SMS batching is deterministic and omits no credential', () => {
        const input = {
            type: 'pin', serviceId: 'waec', reference: 'REF-BATCH',
            details: { productName: 'WAEC Result Checker' }, brand: { siteName: 'Zantara' },
            fulfillment: {
                complete: true,
                items: Array.from({ length: 5 }, (_, index) => ({
                    code: `LONG-PIN-${index + 1}-1234567890`, serial: `SER-${index + 1}`,
                })),
            },
            maxLength: 120,
        };
        const first = buildCredentialSmsBatches(input);
        const second = buildCredentialSmsBatches(input);
        assert.deepStrictEqual(first, second);
        assert.ok(first.length > 1);
        for (let index = 1; index <= 5; index++) {
            assert.ok(first.join(' ').includes(`LONG-PIN-${index}-1234567890`));
        }
    });

    await test('13. incomplete fulfillment never generates credential SMS', () => {
        const messages = buildCredentialSmsBatches({
            type: 'pin', serviceId: 'waec', reference: 'REF-INCOMPLETE',
            fulfillment: { items: [{ code: 'DO-NOT-SEND', serial: null }], complete: false },
        });
        assert.deepStrictEqual(messages, []);
    });

    await test('14. credential SMS batches use deterministic keys and duplicate execution sends once', async () => {
        const originals = {
            sendInApp: notificationService.sendInApp,
            sendSMS: notificationService.sendSMS,
            notificationFindOne: Notification.findOne,
            create: SmsDelivery.create,
            findOne: SmsDelivery.findOne,
            findOneAndUpdate: SmsDelivery.findOneAndUpdate,
            updateOne: SmsDelivery.updateOne,
        };
        const notificationEvents = new Set();
        const batchEvents = new Map();
        const createdBatchKeys = [];
        let smsCount = 0;
        notificationService.sendInApp = async (_userId, _content, eventKey) => {
            if (notificationEvents.has(eventKey)) return null;
            notificationEvents.add(eventKey);
            return { _id: 'notification-1' };
        };
        Notification.findOne = ({ eventKey }) => ({
            lean: async () => notificationEvents.has(eventKey) ? { eventKey } : null,
        });
        notificationService.sendSMS = async (_phone, message) => {
            smsCount++;
            const secondBatchAttempts = batchEvents.get('purchase_success:REF-DEDUP:sms:2')?.attempts || 0;
            return { success: message === 'batch two' && secondBatchAttempts === 1 ? false : true };
        };
        SmsDelivery.findOneAndUpdate = async (filter, update) => {
            const record = batchEvents.get(filter.eventKey);
            if (!record || record.status !== 'failed') return null;
            record.status = update.$set.status;
            record.attempts++;
            return record;
        };
        SmsDelivery.findOne = async ({ eventKey }) => batchEvents.get(eventKey) || null;
        SmsDelivery.create = async document => {
            if (batchEvents.has(document.eventKey)) {
                const error = new Error('duplicate');
                error.code = 11000;
                throw error;
            }
            const record = { _id: document.eventKey, ...document, attempts: 1 };
            batchEvents.set(document.eventKey, record);
            createdBatchKeys.push(document.eventKey);
            return record;
        };
        SmsDelivery.updateOne = async (filter, update) => {
            const record = batchEvents.get(filter._id);
            record.status = update.$set.status;
            return { modifiedCount: 1 };
        };
        const payload = {
            title: 'Success', message: 'Credential-free in-app body', type: 'transaction',
            smsMessages: ['batch one', 'batch two'], activityType: 'purchase_success',
            metadata: { transactionId: 'REF-DEDUP' }, eventKey: 'purchase_success:REF-DEDUP',
        };
        try {
            await notificationService.notify({ _id: new mongoose.Types.ObjectId(), phone: '08012345678' }, payload);
            await new Promise(resolve => setTimeout(resolve, 20));
            await notificationService.notify({ _id: new mongoose.Types.ObjectId(), phone: '08012345678' }, payload);
            await new Promise(resolve => setTimeout(resolve, 20));
            assert.deepStrictEqual(createdBatchKeys, [
                'purchase_success:REF-DEDUP:sms:1',
                'purchase_success:REF-DEDUP:sms:2',
            ]);
            assert.strictEqual(batchEvents.get('purchase_success:REF-DEDUP:sms:1').attempts, 1);
            assert.strictEqual(batchEvents.get('purchase_success:REF-DEDUP:sms:2').attempts, 2);
            assert.strictEqual(smsCount, 3);
        } finally {
            notificationService.sendInApp = originals.sendInApp;
            notificationService.sendSMS = originals.sendSMS;
            Notification.findOne = originals.notificationFindOne;
            SmsDelivery.create = originals.create;
            SmsDelivery.findOne = originals.findOne;
            SmsDelivery.findOneAndUpdate = originals.findOneAndUpdate;
            SmsDelivery.updateOne = originals.updateOne;
        }
    });

    await test('14b. persisted in-app and push bodies remain credential-free', async () => {
        const originals = {
            createEvent: notificationService._createEventDeduped,
            pushToUser: notificationService._pushToUser,
        };
        let persistedMessage;
        let pushBody;
        notificationService._createEventDeduped = async content => {
            persistedMessage = content.message;
            return { _id: 'safe-notification' };
        };
        notificationService._pushToUser = (_userId, payload) => { pushBody = payload.body; };
        try {
            const content = buildPurchaseSuccessContent({
                type: 'pin', serviceId: 'waec', amount: 1000, reference: 'REF-SAFE-BODIES',
                details: { productName: 'WAEC Result Checker' }, brand: { siteName: 'Zantara' },
                fulfillment: { complete: true, items: [{ code: 'PIN-SMS-ONLY', serial: null }] },
            });
            await notificationService.sendInApp(
                new mongoose.Types.ObjectId(),
                { title: content.title, message: content.message, type: 'transaction', metadata: {} },
                'purchase_success:REF-SAFE-BODIES'
            );
            assert.ok(!persistedMessage.includes('PIN-SMS-ONLY'));
            assert.ok(!pushBody.includes('PIN-SMS-ONLY'));
            assert.ok(content.smsMessages[0].includes('PIN-SMS-ONLY'));
        } finally {
            notificationService._createEventDeduped = originals.createEvent;
            notificationService._pushToUser = originals.pushToUser;
        }
    });

    await test('15. VTPass operational logs exclude request and fulfillment credentials', async () => {
        const originalPost = axios.post;
        const originalLog = console.log;
        const logs = [];
        axios.post = async () => ({ data: { code: '000', token: 'LOG-SECRET-TOKEN' } });
        console.log = (...args) => logs.push(args.map(String).join(' '));
        try {
            const adapter = new VTPassAdapter({ baseUrl: 'https://provider.test' });
            await adapter._pay({
                request_id: 'SAFE-REF', phone: '08099999999', billersCode: '12345678901',
            });
            const output = logs.join('\n');
            assert.ok(output.includes('SAFE-REF'));
            assert.ok(!output.includes('08099999999'));
            assert.ok(!output.includes('12345678901'));
            assert.ok(!output.includes('LOG-SECRET-TOKEN'));
        } finally {
            axios.post = originalPost;
            console.log = originalLog;
        }
    });

    const originals = {
        startSession: mongoose.startSession,
        transactionCreate: Transaction.create,
        transactionFindById: Transaction.findById,
        transactionFindOneAndUpdate: Transaction.findOneAndUpdate,
        transactionUpdateOne: Transaction.updateOne,
        userFindById: User.findById,
        walletFindOne: Wallet.findOne,
        expenseCreate: Expense.create,
        verifyPin: pinService.verifyPin,
        walletDebit: walletService.debit,
        resolvePricing: pricingService.resolvePricing,
        selectBestOffer: procurementService.selectBestOffer,
        commission: referral.processLifetimeCommission,
        notifySuccess: notificationService.notifyPurchaseSuccess,
    };
    const transactions = [];
    const userId = new mongoose.Types.ObjectId();
    const service = {
        _id: new mongoose.Types.ObjectId(), code: 'WAEC_RESULT_CHECKER', name: 'WAEC Result Checker',
        category: 'pin', status: true,
    };
    const offer = {
        _id: new mongoose.Types.ObjectId(), serviceId: service._id,
        providerId: { _id: new mongoose.Types.ObjectId(), name: 'VTPass', status: 'active' },
        providerCode: 'waec-pin', providerServiceCode: 'waec', status: true,
    };
    let committed = false;
    let notificationPayload = null;
    let lastFinalizeFilter = null;
    let lastEvidenceFilter = null;
    mongoose.startSession = async () => ({
        startTransaction() {},
        async commitTransaction() { committed = true; },
        async abortTransaction() {},
        endSession() {},
    });
    pinService.verifyPin = async () => true;
    User.findById = () => ({
        session: async () => ({ _id: userId, name: 'Owner', phone: '08012345678', role: 'user', kycLevel: 2 }),
        then: resolve => Promise.resolve(resolve({ _id: userId, name: 'Owner', phone: '08012345678', role: 'user', kycLevel: 2 })),
    });
    Wallet.findOne = async () => ({ balance: 100000 });
    walletService.debit = async () => true;
    pricingService.resolvePricing = async (_user, _service, _offer, amount, quantity) => ({
        baseCostPrice: Number(amount) * quantity,
        salePrice: Number(amount) * quantity,
        quantity,
    });
    procurementService.selectBestOffer = async () => offer;
    Expense.create = async () => [];
    referral.processLifetimeCommission = async () => 0;
    notificationService.notifyPurchaseSuccess = async (_user, payload) => {
        const transaction = transactions.find(item => item.refId === payload.reference);
        assert.strictEqual(committed, true);
        assert.ok(transaction.fulfillment.items.every(item => item.code.startsWith('enc:v1:')));
        notificationPayload = payload;
    };
    Transaction.create = async document => {
        const transaction = {
            ...document,
            _id: new mongoose.Types.ObjectId(),
            isLoss: false,
            async save() { return this; },
            toObject() { return { ...this }; },
        };
        transactions.push(transaction);
        return transaction;
    };
    Transaction.findById = id => ({
        session: async () => transactions.find(item => String(item._id) === String(id)) || null,
        then: (resolve, reject) => Promise.resolve(transactions.find(item => String(item._id) === String(id)) || null).then(resolve, reject),
    });
    Transaction.updateOne = async (filter, update) => {
        lastEvidenceFilter = filter;
        const transaction = transactions.find(item => String(item._id) === String(filter._id));
        if (!transaction) return { modifiedCount: 0 };
        if (filter['fulfillment.complete']?.$ne === true && transaction.fulfillment?.complete === true) {
            return { modifiedCount: 0 };
        }
        Object.assign(transaction, update.$set || {});
        return { modifiedCount: 1 };
    };
    Transaction.findOneAndUpdate = async (filter, update) => {
        lastFinalizeFilter = filter;
        const transaction = transactions.find(item => String(item._id) === String(filter._id)
            && item.status === filter.status
            && item.providerOutcome === filter.providerOutcome
            && item.resolutionState !== 'finalizing'
            && (filter['fulfillment.complete'] !== true || item.fulfillment?.complete === true));
        if (!transaction) return null;
        Object.assign(transaction, update.$set || {});
        return transaction;
    };

    try {
        await test('16. quantity mismatch stays pending, keeps provider success, and dispatches provider once', async () => {
            transactions.length = 0;
            committed = false;
            notificationPayload = null;
            lastFinalizeFilter = null;
            let providerCalls = 0;
            const result = await purchaseService.processPurchase(userId, {
                type: 'pin', serviceId: service.code, canonicalService: service, amount: 1000, pin: '1234',
                details: { serviceID: 'waec', quantity: 2 },
                providerCall: async () => {
                    providerCalls++;
                    return {
                        success: true, status: 'success', outcome: 'success', transactionId: 'PROVIDER-MISMATCH',
                        fulfillment: { items: [{ code: 'ONLY-ONE-PIN', serial: null }] },
                        raw: { code: '000', tokens: ['ONLY-ONE-PIN'] },
                    };
                },
            });
            const transaction = transactions[0];
            assert.strictEqual(providerCalls, 1);
            assert.strictEqual(result.status, 'pending');
            assert.strictEqual(transaction.status, 'pending');
            assert.strictEqual(transaction.providerOutcome, 'success');
            assert.strictEqual(transaction.resolutionError, 'FULFILLMENT_QUANTITY_MISMATCH');
            assert.strictEqual(transaction.fulfillment.complete, false);
            assert.deepStrictEqual(lastEvidenceFilter['fulfillment.complete'], { $ne: true });
            assert.ok(!JSON.stringify(transaction.providerEvidence).includes('ONLY-ONE-PIN'));
            assert.ok(!JSON.stringify(transaction.response).includes('ONLY-ONE-PIN'));
            assert.strictEqual(notificationPayload, null);
        });

        await test('16b. authoritative success with missing fulfillment fails safely without redispatch', async () => {
            transactions.length = 0;
            committed = false;
            notificationPayload = null;
            let providerCalls = 0;
            const result = await purchaseService.processPurchase(userId, {
                type: 'pin', serviceId: service.code, canonicalService: service, amount: 1000, pin: '1234',
                details: { serviceID: 'waec', quantity: 1 },
                providerCall: async () => {
                    providerCalls++;
                    return { success: true, status: 'success', outcome: 'success', raw: { code: '000' } };
                },
            });
            assert.strictEqual(providerCalls, 1);
            assert.strictEqual(result.status, 'pending');
            assert.strictEqual(transactions[0].providerOutcome, 'success');
            assert.strictEqual(transactions[0].fulfillment.itemCount, 0);
            assert.strictEqual(notificationPayload, null);
        });

        await test('16c. later partial success evidence cannot overwrite complete fulfillment', async () => {
            transactions.length = 0;
            const transaction = await Transaction.create({
                userId, transactionId: 'LOCAL-PRESERVE', refId: 'REF-PRESERVE', type: 'pin', service: service.code,
                status: 'pending', isLoss: false, providerOutcome: 'success', resolutionState: 'unresolved',
                details: { quantity: 2 },
                fulfillment: encryptFulfillment({
                    items: [{ code: 'KEEP-PIN-1' }, { code: 'KEEP-PIN-2' }],
                }, { expectedQuantity: 2, complete: true }),
            });
            await purchaseService._recordProviderEvidence(transaction, {
                success: true, status: 'success', outcome: 'success',
                fulfillment: { items: [{ code: 'PARTIAL-PIN' }] },
                raw: { code: '000', token: 'PARTIAL-PIN' },
            }, true);
            assert.strictEqual(transaction.fulfillment.complete, true);
            assert.deepStrictEqual(decryptFulfillment(transaction.fulfillment).items.map(item => item.code), [
                'KEEP-PIN-1', 'KEEP-PIN-2',
            ]);
            assert.ok(!JSON.stringify(transaction.providerEvidence).includes('PARTIAL-PIN'));
        });

        await test('16d. duplicate credentials cannot satisfy a multi-PIN quantity', async () => {
            transactions.length = 0;
            notificationPayload = null;
            const result = await purchaseService.processPurchase(userId, {
                type: 'pin', serviceId: service.code, canonicalService: service, amount: 1000, pin: '1234',
                details: { serviceID: 'waec', quantity: 2 },
                providerCall: async () => ({
                    success: true, status: 'success', outcome: 'success',
                    fulfillment: { items: [{ code: 'DUPLICATE-PIN' }, { code: 'DUPLICATE-PIN' }] },
                    raw: { code: '000', pins: ['DUPLICATE-PIN', 'DUPLICATE-PIN'] },
                }),
            });
            assert.strictEqual(result.status, 'pending');
            assert.strictEqual(transactions[0].fulfillment.complete, false);
            assert.strictEqual(notificationPayload, null);
        });

        await test('17. complete fulfillment is encrypted before post-commit notification', async () => {
            transactions.length = 0;
            committed = false;
            notificationPayload = null;
            const result = await purchaseService.processPurchase(userId, {
                type: 'pin', serviceId: service.code, canonicalService: service, amount: 1000, pin: '1234',
                details: { serviceID: 'waec', quantity: 2 },
                providerCall: async () => ({
                    success: true, status: 'success', outcome: 'success', transactionId: 'PROVIDER-COMPLETE',
                    fulfillment: { items: [
                        { code: 'PIN-COMPLETE-1', serial: 'SER-COMPLETE-1' },
                        { code: 'PIN-COMPLETE-2', serial: null },
                    ] },
                    raw: { code: '000', tokens: ['PIN-COMPLETE-1', 'PIN-COMPLETE-2'], serials: ['SER-COMPLETE-1'] },
                }),
            });
            const transaction = transactions[0];
            assert.strictEqual(result.success, true);
            assert.strictEqual(transaction.status, 'success');
            assert.strictEqual(lastFinalizeFilter['fulfillment.complete'], true);
            assert.strictEqual(notificationPayload.fulfillment.complete, true);
            assert.deepStrictEqual(notificationPayload.fulfillment.items.map(item => item.code), [
                'PIN-COMPLETE-1', 'PIN-COMPLETE-2',
            ]);
            const persisted = JSON.stringify({
                fulfillment: transaction.fulfillment,
                evidence: transaction.providerEvidence,
                response: transaction.response,
            });
            assert.ok(!persisted.includes('PIN-COMPLETE-1'));
            assert.ok(!persisted.includes('SER-COMPLETE-1'));
        });

        await test('18. requery-resolved success uses the same encrypted fulfillment and notification path', async () => {
            transactions.length = 0;
            committed = false;
            notificationPayload = null;
            const transaction = await Transaction.create({
                userId, transactionId: 'LOCAL-REQUERY', refId: 'REF-REQUERY', type: 'pin', service: service.code,
                status: 'pending', isLoss: false, providerOutcome: 'pending', dispatchState: 'dispatched',
                resolutionState: 'unresolved', amount: 1000, costPrice: 900, profit: 100,
                details: { quantity: 1, productName: service.name },
            });
            const result = await purchaseService.resolveExistingTransaction(transaction._id, {
                success: true, status: 'success', outcome: 'success', transactionId: 'PROVIDER-REQUERY',
                token: 'PIN-REQUERY-1', raw: { code: '000', token: 'PIN-REQUERY-1' },
            }, { isRequery: true });
            assert.strictEqual(result.success, true);
            assert.strictEqual(transaction.status, 'success');
            assert.match(transaction.fulfillment.items[0].code, /^enc:v1:/);
            assert.ok(!JSON.stringify(transaction.providerEvidence).includes('PIN-REQUERY-1'));
            assert.strictEqual(notificationPayload.fulfillment.items[0].code, 'PIN-REQUERY-1');
        });

        await test('19. notification failure never alters a financially successful transaction', async () => {
            transactions.length = 0;
            committed = false;
            notificationService.notifyPurchaseSuccess = async () => { throw new Error('SMS unavailable'); };
            const result = await purchaseService.processPurchase(userId, {
                type: 'pin', serviceId: service.code, canonicalService: service, amount: 1000, pin: '1234',
                details: { serviceID: 'waec', quantity: 1 },
                providerCall: async () => ({
                    success: true, status: 'success', outcome: 'success',
                    fulfillment: { items: [{ code: 'PIN-NOTIFY-FAIL', serial: null }] },
                    raw: { code: '000', token: 'PIN-NOTIFY-FAIL' },
                }),
            });
            await new Promise(resolve => setTimeout(resolve, 10));
            assert.strictEqual(result.success, true);
            assert.strictEqual(transactions[0].status, 'success');
        });
    } finally {
        mongoose.startSession = originals.startSession;
        Transaction.create = originals.transactionCreate;
        Transaction.findById = originals.transactionFindById;
        Transaction.findOneAndUpdate = originals.transactionFindOneAndUpdate;
        Transaction.updateOne = originals.transactionUpdateOne;
        User.findById = originals.userFindById;
        Wallet.findOne = originals.walletFindOne;
        Expense.create = originals.expenseCreate;
        pinService.verifyPin = originals.verifyPin;
        walletService.debit = originals.walletDebit;
        pricingService.resolvePricing = originals.resolvePricing;
        procurementService.selectBestOffer = originals.selectBestOffer;
        referral.processLifetimeCommission = originals.commission;
        notificationService.notifyPurchaseSuccess = originals.notifySuccess;
    }

    console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
