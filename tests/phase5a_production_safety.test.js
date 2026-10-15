'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const PaymentGateway = require('../models/PaymentGateway');
const TransactionStatus = require('../models/TransactionStatus');
const WebhookEvent = require('../models/WebhookEvent');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const PaystackAdapter = require('../adapters/payment/paystack.adapter');
const paymentGatewayService = require('../services/paymentGateway.service');
const virtualAccountService = require('../services/virtualAccount.service');
const { MongoVirtualAccountRepository } = require('../services/virtualAccount.service');
const adminGatewayController = require('../controllers/adminPaymentGatewayController');
const { encryptSecret, isEncrypted } = require('../utils/crypto');
const {
    REQUIRED_INDEXES,
    inspectIndexCatalog,
    assertIndexCatalogSafe,
    isTransactionCapableTopology,
    inspectPaystackDvaOwnership,
    assertDvaOwnershipSafe
} = require('../scripts/verify_phase5a_production_prerequisites');
const {
    INDEX: WALLET_INDEX,
    indexMatches: walletIndexMatches,
    inspectWallets,
    assertWalletsSafe
} = require('../scripts/migrate_phase5a_wallet_identity_index');

const response = () => ({
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
});

test('Paystack runtime configuration is database-only and fails closed', async t => {
    await t.test('adapter ignores PAYSTACK_SECRET_KEY environment fallback', () => {
        const previous = process.env.PAYSTACK_SECRET_KEY;
        process.env.PAYSTACK_SECRET_KEY = 'sk_env_must_not_be_used';
        try {
            const adapter = new PaystackAdapter({ code: 'paystack' });
            assert.equal(adapter.secretKey, '');
            assert.throws(() => adapter._apiHeaders(), error => error.code === 'PAYSTACK_CONFIGURATION_INVALID');
        } finally {
            if (previous === undefined) delete process.env.PAYSTACK_SECRET_KEY;
            else process.env.PAYSTACK_SECRET_KEY = previous;
        }
    });

    await t.test('empty gateway collection does not synthesize Paystack from environment', async () => {
        const originalCount = PaymentGateway.countDocuments;
        const previous = process.env.PAYSTACK_SECRET_KEY;
        PaymentGateway.countDocuments = async () => 0;
        process.env.PAYSTACK_SECRET_KEY = 'sk_env_must_not_be_used';
        try {
            assert.equal(await paymentGatewayService.getGateway('paystack'), null);
        } finally {
            PaymentGateway.countDocuments = originalCount;
            if (previous === undefined) delete process.env.PAYSTACK_SECRET_KEY;
            else process.env.PAYSTACK_SECRET_KEY = previous;
        }
    });

    await t.test('production readiness check rejects a missing DB gateway', async () => {
        const original = paymentGatewayService.getGateway;
        paymentGatewayService.getGateway = async () => null;
        try {
            await assert.rejects(
                paymentGatewayService.assertDatabaseManagedPaystackReady(),
                /Database-managed Paystack gateway is required/
            );
        } finally {
            paymentGatewayService.getGateway = original;
        }
    });

    await t.test('production readiness rejects inactive, test, missing, and undecryptable configurations', async () => {
        const original = paymentGatewayService.getGateway;
        const hydrate = overrides => paymentGatewayService._hydrateGatewayCredentials({
            code: 'paystack',
            adapterType: 'paystack',
            status: 'active',
            environment: 'live',
            publicKey: 'pk_live_public',
            secretKey: encryptSecret('sk_live_secret'),
            webhookSecret: '',
            ...(overrides || {})
        });
        const valid = hydrate();
        const cases = [
            [{ ...valid, status: 'inactive' }, /must be active/],
            [{ ...valid, environment: 'test', publicKey: 'pk_test_public', secretKey: 'sk_test_secret' }, /requires a live/],
            [{ ...valid, publicKey: '' }, /public key is required/],
            [{ ...valid, secretKey: '' }, /unavailable or unreadable/],
            [{ ...valid, secretKey: 'enc:v1:unreadable' }, /unavailable or unreadable/],
            [{ ...valid, webhookSecret: 'enc:v1:unreadable' }, /webhook secret is unreadable/],
            [hydrate({ secretKey: 'sk_live_plaintext' }), /encrypted at rest/]
        ];
        try {
            for (const [gateway, expected] of cases) {
                paymentGatewayService.getGateway = async () => gateway;
                await assert.rejects(
                    paymentGatewayService.assertDatabaseManagedPaystackReady({ requireLive: true }),
                    expected
                );
            }
        } finally {
            paymentGatewayService.getGateway = original;
        }
    });

    await t.test('production readiness accepts only an active live Paystack configuration', async () => {
        const original = paymentGatewayService.getGateway;
        paymentGatewayService.getGateway = async () => paymentGatewayService._hydrateGatewayCredentials({
            code: 'paystack',
            adapterType: 'paystack',
            status: 'active',
            environment: 'live',
            publicKey: 'pk_live_public',
            secretKey: encryptSecret('sk_live_secret'),
            webhookSecret: encryptSecret('sk_live_secret')
        });
        try {
            assert.equal(
                await paymentGatewayService.assertDatabaseManagedPaystackReady({ requireLive: true }),
                true
            );
        } finally {
            paymentGatewayService.getGateway = original;
        }
    });
});

test('DVA claim rejects a stale gateway mutation version before writing the user', async () => {
    let userWrites = 0;
    let aborted = 0;
    let ended = 0;
    const session = {
        startTransaction() {},
        async commitTransaction() { throw new Error('must not commit'); },
        async abortTransaction() { aborted++; },
        async endSession() { ended++; }
    };
    const repository = new MongoVirtualAccountRepository({
        async findOneAndUpdate() { userWrites++; return {}; }
    }, {
        PaymentGatewayModel: {
            async updateOne(filter) {
                assert.equal(filter.virtualAccountMutationVersion, 7);
                return { matchedCount: 0 };
            }
        },
        startSession: async () => session
    });

    await assert.rejects(
        repository.claimProvisioning({
            userId: 'user-1',
            provider: 'paystack',
            gatewayId: 'gateway-paystack',
            gatewayMutationVersion: 7,
            provisioningKey: 'paystack:gateway-paystack',
            preferredBank: 'wema-bank',
            consentGrantedAt: new Date(),
            gatewayContext: 'context-1'
        }),
        error => error.code === 'VIRTUAL_ACCOUNT_GATEWAY_CHANGED' && error.httpStatus === 409
    );
    assert.equal(userWrites, 0);
    assert.equal(aborted, 1);
    assert.equal(ended, 1);
});

test('DVA claim retries a transient gateway write conflict without changing the admin mutation version', async () => {
    let gatewayWrites = 0;
    let userWrites = 0;
    let starts = 0;
    let commits = 0;
    let aborts = 0;
    const session = {
        startTransaction() { starts++; },
        async commitTransaction() { commits++; },
        async abortTransaction() { aborts++; },
        async endSession() {}
    };
    const repository = new MongoVirtualAccountRepository({
        async findOneAndUpdate(filter, update) {
            userWrites++;
            assert.equal(update.$set['virtualAccountPreferences.paystack.preferredBank'], 'wema-bank');
            return { _id: filter._id };
        }
    }, {
        PaymentGatewayModel: {
            async updateOne(filter, update) {
                gatewayWrites++;
                assert.equal(filter.virtualAccountMutationVersion, 4);
                assert.deepEqual(update, { $inc: { virtualAccountClaimVersion: 1 } });
                if (gatewayWrites === 1) {
                    const error = new Error('write conflict');
                    error.code = 112;
                    throw error;
                }
                return { matchedCount: 1 };
            }
        },
        startSession: async () => session
    });

    const claim = await repository.claimProvisioning({
        userId: 'user-1',
        provider: 'paystack',
        gatewayId: 'gateway-paystack',
        gatewayMutationVersion: 4,
        provisioningKey: 'paystack:gateway-paystack',
        preferredBank: 'wema-bank',
        consentGrantedAt: new Date(),
        gatewayContext: 'context-1'
    });

    assert.equal(claim.claimed, true);
    assert.equal(gatewayWrites, 2);
    assert.equal(userWrites, 1);
    assert.equal(starts, 2);
    assert.equal(aborts, 1);
    assert.equal(commits, 1);
});

test('Paystack DVA gateway lifecycle retains verification and blocks deletion', async t => {
    const originals = {
        findById: PaymentGateway.findById,
        updateOne: PaymentGateway.updateOne,
        findByIdAndDelete: PaymentGateway.findByIdAndDelete,
        startSession: require('mongoose').startSession,
        transactionCount: TransactionStatus.countDocuments,
        webhookCount: WebhookEvent.countDocuments,
        webhookCreate: WebhookEvent.create,
        webhookFindOneAndUpdate: WebhookEvent.findOneAndUpdate,
        userCount: User.countDocuments,
        auditCreate: AuditLog.create,
        getGateway: paymentGatewayService.getGateway,
        assignmentHandler: virtualAccountService.handlePaystackAssignmentWebhook
    };
    const gateway = {
        _id: 'gateway-paystack',
        name: 'Paystack',
        code: 'paystack',
        adapterType: 'paystack',
        status: 'active',
        environment: 'live',
        isDefault: false,
        publicKey: 'pk_live_old',
        secretKey: encryptSecret('sk_live_old'),
        webhookSecret: encryptSecret('sk_live_old'),
        baseUrl: 'https://api.paystack.co',
        supportedChannels: ['card'],
        metadata: {},
        webhookVerificationSnapshots: [],
        markModified() {},
        async save() { return this; }
    };
    let deleted = false;
    let gatewayFenced = false;

    PaymentGateway.findById = async id => String(id) === String(gateway._id) ? gateway : null;
    PaymentGateway.updateOne = async () => {
        gatewayFenced = true;
        return { matchedCount: 1 };
    };
    PaymentGateway.findByIdAndDelete = async () => { deleted = true; return gateway; };
    require('mongoose').startSession = async () => ({
        startTransaction() {},
        async commitTransaction() {},
        async abortTransaction() {},
        async endSession() {}
    });
    TransactionStatus.countDocuments = async () => 0;
    WebhookEvent.countDocuments = async () => 0;
    User.countDocuments = async filter => {
        assert.equal(gatewayFenced, true, 'gateway fence must be acquired before the DVA reference check');
        return filter?.virtualAccounts?.$elemMatch?.provider === 'paystack' ? 1 : 0;
    };
    AuditLog.create = async value => value;

    t.after(() => {
        PaymentGateway.findById = originals.findById;
        PaymentGateway.updateOne = originals.updateOne;
        PaymentGateway.findByIdAndDelete = originals.findByIdAndDelete;
        require('mongoose').startSession = originals.startSession;
        TransactionStatus.countDocuments = originals.transactionCount;
        WebhookEvent.countDocuments = originals.webhookCount;
        WebhookEvent.create = originals.webhookCreate;
        WebhookEvent.findOneAndUpdate = originals.webhookFindOneAndUpdate;
        User.countDocuments = originals.userCount;
        AuditLog.create = originals.auditCreate;
        paymentGatewayService.getGateway = originals.getGateway;
        virtualAccountService.handlePaystackAssignmentWebhook = originals.assignmentHandler;
    });

    await t.test('credential rotation archives the previous trusted configuration', async () => {
        const res = response();
        await adminGatewayController.updateGateway({
            params: { id: gateway._id },
            body: { secretKey: 'sk_live_new', webhookSecret: 'sk_live_new' },
            user: { id: 'admin-1', name: 'Admin' },
            headers: {},
            ip: '127.0.0.1'
        }, res);

        assert.equal(res.statusCode, 200);
        assert.equal(gateway.webhookVerificationSnapshots.length, 1);
        const snapshot = gateway.webhookVerificationSnapshots[0];
        assert.equal(snapshot.gatewayId, gateway._id);
        assert.equal(isEncrypted(snapshot.secretKey), true);
        assert.notEqual(gateway.secretKey, snapshot.secretKey);
    });

    await t.test('Paystack API secret rotation also rotates the webhook signing context', async () => {
        const res = response();
        const previousSecret = gateway.secretKey;
        await adminGatewayController.updateGateway({
            params: { id: gateway._id },
            body: { secretKey: 'sk_live_next' },
            user: { id: 'admin-1', name: 'Admin' },
            headers: {},
            ip: '127.0.0.1'
        }, res);

        assert.equal(res.statusCode, 200);
        assert.notEqual(gateway.secretKey, previousSecret);
        assert.equal(gateway.webhookVerificationSnapshots.length, 2);
        assert.equal(gateway.webhookVerificationSnapshots[1].secretKey, previousSecret);
    });

    await t.test('stored historical secret verifies exact raw webhook after rotation', () => {
        const body = Buffer.from('{"event":"charge.success","data":{"id":71}}');
        const signature = crypto.createHmac('sha512', 'sk_live_old').update(body).digest('hex');
        const hydrated = paymentGatewayService._hydrateGatewayCredentials(gateway);
        const selected = paymentGatewayService._selectWebhookGateway(
            hydrated,
            { 'x-paystack-signature': signature },
            body
        );
        assert.equal(selected.matched, true);
        assert.equal(selected.gateway.secretKey, 'sk_live_old');

        const tampered = paymentGatewayService._selectWebhookGateway(
            hydrated,
            { 'x-paystack-signature': signature },
            Buffer.from('{"event":"charge.success","data":{"id":72}}')
        );
        assert.equal(tampered.matched, false);
    });

    await t.test('unified webhook route selects the archived verification context', async () => {
        const hydrated = paymentGatewayService._hydrateGatewayCredentials(gateway);
        paymentGatewayService.getGateway = async () => hydrated;
        let selectedSecret = null;
        virtualAccountService.handlePaystackAssignmentWebhook = async ({ gateway: selectedGateway }) => {
            selectedSecret = selectedGateway.secretKey;
        };
        WebhookEvent.create = async value => ({ ...value });
        WebhookEvent.findOneAndUpdate = async () => ({ status: 'processed' });

        const payload = {
            event: 'dedicatedaccount.assign.failed',
            data: { customer_id: 81, customer_code: 'CUS_ada', reason: 'provider failure' }
        };
        const body = Buffer.from(JSON.stringify(payload));
        const signature = crypto.createHmac('sha512', 'sk_live_old').update(body).digest('hex');
        const result = await paymentGatewayService.routeWebhook('paystack', {
            body,
            headers: { 'x-paystack-signature': signature }
        });

        assert.equal(result.status, 200);
        assert.equal(selectedSecret, 'sk_live_old');
    });

    await t.test('gateway deletion is blocked while any Paystack DVA references it', async () => {
        const res = response();
        await adminGatewayController.deleteGateway({
            params: { id: gateway._id },
            user: { id: 'admin-1', name: 'Admin' },
            headers: {},
            ip: '127.0.0.1'
        }, res);
        assert.equal(res.statusCode, 400);
        assert.match(res.body.message, /virtual-account users/);
        assert.equal(deleted, false);
    });
});

test('Phase 5A ownership and transaction prerequisites fail closed', async t => {
    const gateway = { _id: 'gw-1', code: 'paystack', adapterType: 'paystack' };
    const snapshot = { PAYSTACK_DVA_91: { code: 'paystack', adapterType: 'paystack' } };
    const account = userId => ({
        userId,
        gatewayId: 'gw-1',
        accountNumber: '0123456789',
        accountReference: 'PAYSTACK_DVA_91',
        providerAccountId: '91',
        providerCustomerId: '81',
        providerCustomerCode: 'CUS_ada',
        currency: 'NGN',
        active: true,
        assigned: true,
        provisioningKey: `paystack:gw-1`,
        provisioningStatus: 'active',
        virtualAccountGatewaySnapshots: snapshot
    });

    await t.test('duplicate DVA owner identities are deployment blockers', () => {
        const report = inspectPaystackDvaOwnership([account('user-1'), account('user-2')], [gateway]);
        assert.ok(report.duplicates.accountNumber > 0);
        assert.throws(() => assertDvaOwnershipSafe(report), /ownership preflight/);
    });

    await t.test('same-user duplicate account identities are also blockers', () => {
        const report = inspectPaystackDvaOwnership([account('user-1'), account('user-1')], [gateway]);
        assert.ok(report.duplicates.providerAccountId > 0);
        assert.throws(() => assertDvaOwnershipSafe(report), /ownership preflight/);
    });

    await t.test('valid DVA ownership passes the read-only preflight', () => {
        const report = inspectPaystackDvaOwnership([account('user-1')], [gateway]);
        assert.doesNotThrow(() => assertDvaOwnershipSafe(report));
    });

    await t.test('transaction support requires sessions plus replica-set or sharded topology', () => {
        assert.equal(isTransactionCapableTopology({
            topologyType: 'ReplicaSetWithPrimary',
            hello: { setName: 'rs0', logicalSessionTimeoutMinutes: 30 }
        }), true);
        assert.equal(isTransactionCapableTopology({
            topologyType: 'Single',
            hello: { logicalSessionTimeoutMinutes: 30 }
        }), false);
    });

    await t.test('exactly-once index verification rejects missing indexes', () => {
        const report = inspectIndexCatalog({});
        assert.equal(report.missing.length, Object.values(REQUIRED_INDEXES).flat().length);
        assert.throws(() => assertIndexCatalogSafe(report), /index prerequisites failed/);
    });

    await t.test('complete exact index catalog passes', () => {
        const catalog = Object.fromEntries(Object.entries(REQUIRED_INDEXES).map(([collection, indexes]) => [
            collection,
            indexes.map(index => ({ ...index }))
        ]));
        const report = inspectIndexCatalog(catalog);
        assert.doesNotThrow(() => assertIndexCatalogSafe(report));
    });

    await t.test('wallet uniqueness is explicit and duplicate wallets block migration', () => {
        assert.equal(walletIndexMatches({ ...WALLET_INDEX }), true);
        assert.throws(
            () => assertWalletsSafe({ missingUserId: 0, duplicateUsers: [{ count: 2 }] }),
            /duplicate wallet ownership/
        );
    });

    await t.test('one null-owned wallet is detected and blocks migration', async () => {
        const collection = {
            async countDocuments(filter) {
                if (filter.userId?.$type === 'null') return 1;
                return 0;
            },
            aggregate(pipeline) {
                assert.equal(pipeline[0].$match.userId.$ne, null);
                return { async toArray() { return []; } };
            }
        };
        const report = await inspectWallets(collection);
        assert.equal(report.nullUserId, 1);
        assert.throws(() => assertWalletsSafe(report), /null userId/);
    });
});
