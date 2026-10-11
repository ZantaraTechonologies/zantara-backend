'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const axios = require('axios');

const paymentGatewayService = require('../services/paymentGateway.service');
const virtualAccountService = require('../services/virtualAccount.service');
const TransactionStatus = require('../models/TransactionStatus');
const WebhookEvent = require('../models/WebhookEvent');
const walletService = require('../services/wallet.service');

const SECRET = 'sk_test_dva_webhook';
const GATEWAY_ID = 'gateway-paystack';

const queryResult = value => ({
    select: () => queryResult(value),
    limit: () => queryResult(value),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
    catch: reject => Promise.resolve(value).catch(reject)
});

const matchesValue = (actual, expected) => {
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
        if (expected.$lte) return actual != null && new Date(actual) <= new Date(expected.$lte);
        if (Object.prototype.hasOwnProperty.call(expected, '$exists')) {
            return expected.$exists ? actual !== undefined : actual === undefined;
        }
    }
    return actual === expected;
};

const matchesEvent = (event, filter = {}) => {
    if (filter.$or && !filter.$or.some(part => matchesEvent(event, part))) return false;
    return Object.entries(filter).every(([key, expected]) => key === '$or' || matchesValue(event[key], expected));
};

class FakeWebhookRepository {
    constructor(accounts = []) {
        this.userId = 'user-1';
        this.accounts = accounts.map(account => ({ ...account }));
        this.completionCount = 0;
        this.failureCount = 0;
        this.failNextAssignmentClaim = false;
    }

    async findPaystackProvisioningForAssignment({ gatewayId, gatewayContexts, providerCustomerId, providerCustomerCode }) {
        const matches = this.accounts.filter(account =>
            account.provider === 'paystack'
            && String(account.gatewayId) === String(gatewayId)
            && account.provisioningKey === `paystack:${gatewayId}`
            && ['pending', 'failed', 'active'].includes(account.provisioningStatus)
            && String(account.providerCustomerId) === String(providerCustomerId)
            && account.providerCustomerCode === providerCustomerCode
            && (!account.provisioningGatewayContext || gatewayContexts.includes(account.provisioningGatewayContext))
        );
        return {
            match: matches.length === 1
                ? { userId: this.userId, account: { ...matches[0] }, token: matches[0].provisioningToken }
                : null,
            matchCount: matches.length
        };
    }

    async claimPaystackAssignment({ account, gatewayContext }) {
        if (this.failNextAssignmentClaim) {
            this.failNextAssignmentClaim = false;
            const changed = this.accounts.find(item => item.provisioningKey === account.provisioningKey);
            if (changed) changed.provisioningToken = 'newer-worker-token';
            return { claimed: false, token: null };
        }
        const current = this.accounts.find(item =>
            item.provisioningKey === account.provisioningKey
            && item.provisioningStatus === account.provisioningStatus
            && item.provisioningToken === account.provisioningToken
            && item.providerCustomerCode === account.providerCustomerCode
        );
        if (!current) return { claimed: false, token: null };
        const token = `webhook-recovery-${this.completionCount + 1}`;
        current.provisioningStatus = 'pending';
        current.provisioningToken = token;
        current.provisioningGatewayContext = gatewayContext;
        current.provisioningDispatchState = 'reconciling';
        current.provisioningExpiresAt = new Date(Date.now() + 15 * 60_000);
        return { claimed: true, token };
    }

    async completeProvisioning({ provider, gatewayId, provisioningKey, token, accounts }) {
        const index = this.accounts.findIndex(account =>
            account.provider === provider
            && String(account.gatewayId) === String(gatewayId)
            && account.provisioningKey === provisioningKey
            && account.provisioningToken === token
            && account.provisioningStatus === 'pending'
        );
        if (index < 0) {
            const error = new Error('claim lost');
            error.code = 'VIRTUAL_ACCOUNT_CLAIM_LOST';
            throw error;
        }
        this.completionCount++;
        this.accounts[index] = {
            ...this.accounts[index],
            ...accounts[0],
            provider,
            gatewayId: String(gatewayId),
            provisioningKey,
            provisioningStatus: 'active',
            provisioningDispatchState: 'complete',
            provisioningExpectedAccountCount: accounts.length,
            provisioningExpiresAt: null
        };
        delete this.accounts[index].provisioningToken;
        return this.accounts.filter(account => account.provider === provider && String(account.gatewayId) === String(gatewayId));
    }

    async markPaystackAssignmentRecoverable({ account: matched, message }) {
        if (matched.provisioningStatus === 'failed') return true;
        const account = this.accounts.find(item =>
            item.provisioningKey === matched.provisioningKey
            && item.provisioningToken === matched.provisioningToken
            && item.provisioningStatus === 'pending'
            && (!item.provisioningDispatchState || ['awaiting_assignment', 'reconciling'].includes(item.provisioningDispatchState))
        );
        if (!account) return false;
        this.failureCount++;
        account.provisioningStatus = 'failed';
        account.provisioningDispatchState = 'retryable';
        account.provisioningFailure = message;
        account.provisioningExpiresAt = null;
        account.active = false;
        account.assigned = false;
        delete account.provisioningToken;
        return true;
    }
}

const pendingAccount = overrides => ({
    provider: 'paystack',
    gatewayId: GATEWAY_ID,
    provisioningKey: `paystack:${GATEWAY_ID}`,
    provisioningStatus: 'pending',
    provisioningDispatchState: 'awaiting_assignment',
    provisioningToken: 'lease-token',
    provisioningStartedAt: new Date(Date.now() - 60_000),
    provisioningExpiresAt: new Date(Date.now() + 10 * 60_000),
    providerCustomerId: '81',
    providerCustomerCode: 'CUS_ada',
    preferredBank: 'wema-bank',
    active: false,
    assigned: false,
    ...overrides
});

const monnifyAccount = () => ({
    provider: 'monnify',
    gatewayId: 'gateway-monnify',
    provisioningKey: 'monnify:gateway-monnify',
    provisioningStatus: 'active',
    accountNumber: '9988776655',
    active: true,
    assigned: true
});

const successPayload = overrides => ({
    event: 'dedicatedaccount.assign.success',
    data: {
        id: 991,
        account_name: 'ZANTARA / ADA LOVELACE',
        account_number: '0123456789',
        currency: 'NGN',
        active: true,
        assigned: true,
        bank: { id: 20, name: 'Wema Bank', slug: 'wema-bank' },
        customer: { id: 81, customer_code: 'CUS_ada' },
        ...overrides
    }
});

const failedPayload = overrides => ({
    event: 'dedicatedaccount.assign.failed',
    data: {
        customer_id: 81,
        customer_code: 'CUS_ada',
        reason: 'Unable to assign dedicated account',
        ...overrides
    }
});

const signedRequest = (payload, secret = SECRET) => {
    const body = Buffer.from(JSON.stringify(payload));
    return {
        body,
        headers: {
            'x-paystack-signature': crypto.createHmac('sha512', secret).update(body).digest('hex')
        }
    };
};

test('Paystack DVA assignment webhooks use the unified authenticated pipeline', async t => {
    const originals = {
        repository: virtualAccountService.repository,
        getGateway: paymentGatewayService.getGateway,
        snapshot: paymentGatewayService._snapshotGatewayConfig,
        transactionFindOne: TransactionStatus.findOne,
        eventCreate: WebhookEvent.create,
        eventFindOne: WebhookEvent.findOne,
        eventFindOneAndUpdate: WebhookEvent.findOneAndUpdate,
        walletCredit: walletService.credit,
        axiosGet: axios.get,
        axiosPost: axios.post
    };
    let events = [];
    let repository;
    let financialCalls = 0;
    let networkCalls = 0;
    let activeGateway;

    const gatewayFixture = overrides => ({
        _id: GATEWAY_ID,
        code: 'paystack',
        adapterType: 'paystack',
        name: 'Paystack',
        status: 'active',
        environment: 'live',
        secretKey: SECRET,
        webhookSecret: SECRET,
        baseUrl: 'https://api.paystack.test',
        webhookVerificationSnapshots: [],
        ...overrides
    });

    const reset = accounts => {
        events = [];
        repository = new FakeWebhookRepository(accounts);
        virtualAccountService.repository = repository;
        financialCalls = 0;
        networkCalls = 0;
        activeGateway = gatewayFixture();
    };

    paymentGatewayService.getGateway = async code => code === 'paystack' ? activeGateway : null;
    paymentGatewayService._snapshotGatewayConfig = gateway => ({ code: gateway.code, adapterType: gateway.adapterType });
    TransactionStatus.findOne = () => {
        financialCalls++;
        return queryResult(null);
    };
    walletService.credit = async () => {
        financialCalls++;
        throw new Error('DVA assignment must not credit a wallet');
    };
    axios.get = async () => {
        networkCalls++;
        throw new Error('live Paystack access is forbidden in this test');
    };
    axios.post = async () => {
        networkCalls++;
        throw new Error('live Paystack access is forbidden in this test');
    };

    WebhookEvent.create = async doc => {
        if (events.some(event => event.provider === doc.provider && event.eventId === doc.eventId)) {
            const error = new Error('duplicate event');
            error.code = 11000;
            throw error;
        }
        const event = { ...doc };
        events.push(event);
        return event;
    };
    WebhookEvent.findOne = filter => queryResult(events.find(event => matchesEvent(event, filter)) || null);
    WebhookEvent.findOneAndUpdate = async (filter, update) => {
        const event = events.find(candidate => matchesEvent(candidate, filter));
        if (!event) return null;
        if (update.$set) Object.assign(event, update.$set);
        if (update.$unset) Object.keys(update.$unset).forEach(key => delete event[key]);
        if (update.$inc) {
            for (const [key, value] of Object.entries(update.$inc)) event[key] = Number(event[key] || 0) + value;
        }
        return event;
    };

    t.after(() => {
        virtualAccountService.repository = originals.repository;
        paymentGatewayService.getGateway = originals.getGateway;
        paymentGatewayService._snapshotGatewayConfig = originals.snapshot;
        TransactionStatus.findOne = originals.transactionFindOne;
        WebhookEvent.create = originals.eventCreate;
        WebhookEvent.findOne = originals.eventFindOne;
        WebhookEvent.findOneAndUpdate = originals.eventFindOneAndUpdate;
        walletService.credit = originals.walletCredit;
        axios.get = originals.axiosGet;
        axios.post = originals.axiosPost;
    });

    await t.test('successful assignment completes only the matching pending Paystack account', async () => {
        const monnify = monnifyAccount();
        reset([pendingAccount(), monnify]);

        const result = await paymentGatewayService.routeWebhook('paystack', signedRequest(successPayload()));

        assert.equal(result.status, 200);
        assert.equal(repository.completionCount, 1);
        const account = repository.accounts.find(item => item.provider === 'paystack');
        assert.equal(account.provisioningStatus, 'active');
        assert.equal(account.accountNumber, '0123456789');
        assert.equal(account.providerAccountId, '991');
        assert.deepEqual(repository.accounts.find(item => item.provider === 'monnify'), monnify);
        assert.equal(events[0].status, 'processed');
        assert.equal(financialCalls, 0);
        assert.equal(networkCalls, 0);
    });

    await t.test('failed assignment marks only the matching provisioning request failed', async () => {
        const monnify = monnifyAccount();
        reset([pendingAccount(), monnify]);

        const result = await paymentGatewayService.routeWebhook('paystack', signedRequest(failedPayload()));

        assert.equal(result.status, 200);
        assert.equal(repository.failureCount, 1);
        assert.equal(repository.accounts[0].provisioningStatus, 'failed');
        assert.match(repository.accounts[0].provisioningFailure, /Unable to assign/);
        assert.deepEqual(repository.accounts[1], monnify);
        assert.equal(events[0].status, 'processed');
    });

    await t.test('unknown customer is rejected without changing provisioning state', async () => {
        reset([pendingAccount()]);
        const payload = successPayload({ customer: { id: 999, customer_code: 'CUS_unknown' } });

        const result = await paymentGatewayService.routeWebhook('paystack', signedRequest(payload));

        assert.equal(result.status, 200);
        assert.equal(repository.accounts[0].provisioningStatus, 'pending');
        assert.equal(repository.completionCount, 0);
        assert.equal(events[0].status, 'failed');
    });

    await t.test('unknown account is rejected when the pending request has a different provider account ID', async () => {
        reset([pendingAccount({ providerAccountId: '991' })]);

        const result = await paymentGatewayService.routeWebhook('paystack', signedRequest(successPayload({ id: 992 })));

        assert.equal(result.status, 200);
        assert.equal(repository.accounts[0].provisioningStatus, 'pending');
        assert.equal(repository.completionCount, 0);
        assert.equal(events[0].status, 'failed');
    });

    await t.test('mismatched gateway cannot complete another gateway provisioning record', async () => {
        reset([pendingAccount({
            gatewayId: 'gateway-other',
            provisioningKey: 'paystack:gateway-other'
        })]);

        const result = await paymentGatewayService.routeWebhook('paystack', signedRequest(successPayload()));

        assert.equal(result.status, 200);
        assert.equal(repository.accounts[0].provisioningStatus, 'pending');
        assert.equal(repository.completionCount, 0);
        assert.equal(events[0].status, 'failed');
    });

    await t.test('delayed signed success safely completes the matching expired provisioning request', async () => {
        reset([pendingAccount({ provisioningExpiresAt: new Date(Date.now() - 1000) })]);

        const result = await paymentGatewayService.routeWebhook('paystack', signedRequest(successPayload()));

        assert.equal(result.status, 200);
        assert.equal(repository.accounts[0].provisioningStatus, 'active');
        assert.equal(repository.completionCount, 1);
        assert.equal(events[0].status, 'processed');
    });

    await t.test('assignment created before rotation completes under the approved new signing context', async () => {
        const oldSecret = 'sk_test_before_rotation';
        const oldGateway = gatewayFixture({
            secretKey: oldSecret,
            webhookSecret: oldSecret,
            webhookVerificationSnapshots: []
        });
        const oldContext = virtualAccountService._paystackGatewayContext(oldGateway);
        reset([pendingAccount({ provisioningGatewayContext: oldContext })]);
        activeGateway = gatewayFixture({
            secretKey: 'sk_test_after_rotation',
            webhookSecret: 'sk_test_after_rotation',
            webhookVerificationSnapshots: [{
                gatewayId: GATEWAY_ID,
                name: 'Paystack',
                code: 'paystack',
                adapterType: 'paystack',
                environment: 'live',
                secretKey: oldSecret,
                webhookSecret: oldSecret,
                baseUrl: 'https://api.paystack.test',
                supportedChannels: ['card'],
                metadata: {}
            }]
        });

        const result = await paymentGatewayService.routeWebhook(
            'paystack',
            signedRequest(successPayload(), 'sk_test_after_rotation')
        );

        assert.equal(result.status, 200);
        assert.equal(repository.accounts[0].provisioningStatus, 'active');
        assert.equal(repository.accounts[0].accountNumber, '0123456789');
        assert.equal(repository.completionCount, 1);
    });

    await t.test('a new-credential signature cannot bypass rotated-operation bank identity', async () => {
        const oldSecret = 'sk_test_before_rotation';
        const oldGateway = gatewayFixture({ secretKey: oldSecret, webhookSecret: oldSecret });
        const oldContext = virtualAccountService._paystackGatewayContext(oldGateway);
        reset([pendingAccount({ provisioningGatewayContext: oldContext })]);
        activeGateway = gatewayFixture({
            secretKey: 'sk_test_after_rotation',
            webhookSecret: 'sk_test_after_rotation',
            webhookVerificationSnapshots: [{
                gatewayId: GATEWAY_ID,
                name: 'Paystack',
                code: 'paystack',
                adapterType: 'paystack',
                environment: 'live',
                secretKey: oldSecret,
                webhookSecret: oldSecret,
                baseUrl: 'https://api.paystack.test'
            }]
        });
        const payload = successPayload({ bank: { id: 999, name: 'Titan', slug: 'titan-paystack' } });

        const result = await paymentGatewayService.routeWebhook(
            'paystack',
            signedRequest(payload, 'sk_test_after_rotation')
        );

        assert.equal(result.status, 200);
        assert.equal(repository.accounts[0].provisioningStatus, 'pending');
        assert.equal(repository.completionCount, 0);
        assert.equal(events[0].status, 'failed');
    });

    await t.test('historical HMAC verification still completes a delayed pre-rotation assignment', async () => {
        const oldSecret = 'sk_test_before_rotation';
        const oldGateway = gatewayFixture({ secretKey: oldSecret, webhookSecret: oldSecret });
        const oldContext = virtualAccountService._paystackGatewayContext(oldGateway);
        reset([pendingAccount({ provisioningGatewayContext: oldContext })]);
        activeGateway = gatewayFixture({
            secretKey: 'sk_test_after_rotation',
            webhookSecret: 'sk_test_after_rotation',
            webhookVerificationSnapshots: [{
                gatewayId: GATEWAY_ID,
                name: 'Paystack',
                code: 'paystack',
                adapterType: 'paystack',
                environment: 'live',
                secretKey: oldSecret,
                webhookSecret: oldSecret,
                baseUrl: 'https://api.paystack.test'
            }]
        });

        const result = await paymentGatewayService.routeWebhook(
            'paystack',
            signedRequest(successPayload(), oldSecret)
        );

        assert.equal(result.status, 200);
        assert.equal(repository.accounts[0].provisioningStatus, 'active');
        assert.equal(repository.completionCount, 1);
    });

    await t.test('malformed assignment payload is terminally rejected without mutation', async () => {
        reset([pendingAccount()]);
        const payload = successPayload({ account_number: '', customer: {} });

        const result = await paymentGatewayService.routeWebhook('paystack', signedRequest(payload));

        assert.equal(result.status, 200);
        assert.equal(repository.accounts[0].provisioningStatus, 'pending');
        assert.equal(repository.completionCount, 0);
        assert.equal(events[0].status, 'failed');
    });

    await t.test('duplicate webhook delivery completes the account once', async () => {
        reset([pendingAccount()]);
        const request = signedRequest(successPayload());

        const first = await paymentGatewayService.routeWebhook('paystack', request);
        const duplicate = await paymentGatewayService.routeWebhook('paystack', request);

        assert.equal(first.status, 200);
        assert.equal(duplicate.status, 200);
        assert.match(duplicate.message, /already processed/);
        assert.equal(repository.completionCount, 1);
        assert.equal(events.length, 1);
    });

    await t.test('duplicate assignment response never replaces an already-provisioned account', async () => {
        reset([pendingAccount()]);
        const first = await paymentGatewayService.routeWebhook('paystack', signedRequest(successPayload()));
        const originalAccount = { ...repository.accounts[0] };
        const secondPayload = successPayload({ duplicate_delivery_marker: 'second-provider-event' });
        const second = await paymentGatewayService.routeWebhook('paystack', signedRequest(secondPayload));

        assert.equal(first.status, 200);
        assert.equal(second.status, 200);
        assert.equal(repository.completionCount, 1);
        assert.deepEqual(repository.accounts[0], originalAccount);
        assert.equal(events.length, 2);
        assert.equal(events[1].status, 'processed');
    });

    await t.test('stale provisioning token cannot complete after a newer worker claims the operation', async () => {
        reset([pendingAccount()]);
        repository.failNextAssignmentClaim = true;

        const result = await paymentGatewayService.routeWebhook('paystack', signedRequest(successPayload()));

        assert.equal(result.status, 503);
        assert.equal(repository.completionCount, 0);
        assert.equal(repository.accounts[0].provisioningStatus, 'pending');
        assert.equal(repository.accounts[0].provisioningToken, 'newer-worker-token');
        assert.equal(events[0].status, 'retryable');
    });

    await t.test('delayed success recovers the same operation after an assignment failure', async () => {
        reset([pendingAccount()]);

        const failed = await paymentGatewayService.routeWebhook('paystack', signedRequest(failedPayload()));
        assert.equal(failed.status, 200);
        assert.equal(repository.accounts[0].provisioningStatus, 'failed');
        assert.equal(repository.accounts[0].provisioningDispatchState, 'retryable');

        const recovered = await paymentGatewayService.routeWebhook('paystack', signedRequest(successPayload()));

        assert.equal(recovered.status, 200);
        assert.equal(repository.accounts[0].provisioningStatus, 'active');
        assert.equal(repository.accounts[0].accountNumber, '0123456789');
        assert.equal(repository.failureCount, 1);
        assert.equal(repository.completionCount, 1);
    });

    await t.test('signed malformed JSON is rejected before event persistence or mutation', async () => {
        reset([pendingAccount()]);
        const body = Buffer.from('{"event":');
        const request = {
            body,
            headers: {
                'x-paystack-signature': crypto.createHmac('sha512', SECRET).update(body).digest('hex')
            }
        };

        const result = await paymentGatewayService.routeWebhook('paystack', request);

        assert.equal(result.status, 400);
        assert.equal(events.length, 0);
        assert.equal(repository.accounts[0].provisioningStatus, 'pending');
    });
});
