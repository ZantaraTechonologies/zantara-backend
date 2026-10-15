'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'phase2a-routes-test-secret';

const { verifyJWT } = require('../middlewares/auth');
const requireOnboardingComplete = require('../middlewares/requireOnboardingComplete');
const requireLegalCompliance = require('../middlewares/requireLegalCompliance');
const { VirtualAccountService } = require('../services/virtualAccount.service');

const routeHandlers = (router, path, method) => {
    const layer = router.stack.find(item => item.route
        && item.route.path === path
        && (!method || item.route.methods[method]));
    return layer ? layer.route.stack.map(item => item.handle) : null;
};

test('financial routes place onboarding after authentication and before legal/payment handlers', () => {
    const wallet = require('../routes/wallet');
    const paystack = require('../routes/paystack');
    const services = require('../routes/services');
    const monnify = require('../routes/monnify');
    const flutterwave = require('../routes/flutterwave');
    const withdrawal = require('../routes/withdrawal');
    const investment = require('../routes/investment');

    for (const [router, path, method] of [
        [wallet, '/fund', 'post'],
        [wallet, '/transfer', 'post'],
        [wallet, '/virtual-accounts/request', 'post'],
        [wallet, '/virtual-accounts/:provider', 'post'],
        [paystack, '/initialize', 'post'],
        [monnify, '/initialize', 'post'],
        [monnify, '/generate-virtual-accounts', 'post'],
        [flutterwave, '/initialize', 'post'],
        [services, '/airtime', 'post'],
        [withdrawal, '/', 'post'],
        [investment, '/buy', 'post']
    ]) {
        const handlers = routeHandlers(router, path, method);
        assert.equal(handlers[0], verifyJWT, `${path} must authenticate first`);
        assert.equal(handlers[1], requireOnboardingComplete, `${path} must enforce onboarding second`);
        assert.ok(handlers.indexOf(requireLegalCompliance) > handlers.indexOf(requireOnboardingComplete));
    }
});

test('customer application routers are guarded while staff roles remain middleware-exempt', () => {
    const bankAccounts = require('../routes/bankAccount');
    const notifications = require('../routes/notification');
    const earnings = require('../routes/userEarnings');
    const pricing = require('../routes/v1/pricing');
    const transactions = require('../routes/transaction');

    for (const router of [bankAccounts, notifications, earnings]) {
        const middleware = router.stack.filter(layer => !layer.route).map(layer => layer.handle);
        assert.equal(middleware[0], verifyJWT);
        assert.equal(middleware[1], requireOnboardingComplete);
    }
    assert.deepEqual(routeHandlers(pricing, '/calculate', 'post').slice(0, 2), [verifyJWT, requireOnboardingComplete]);
    assert.deepEqual(routeHandlers(transactions, '/', 'get').slice(0, 2), [verifyJWT, requireOnboardingComplete]);
});

test('virtual-account status retrieval authenticates and enforces onboarding without requiring legal mutation consent', () => {
    const wallet = require('../routes/wallet');
    const handlers = routeHandlers(wallet, '/virtual-accounts', 'get');
    assert.deepEqual(handlers, [verifyJWT, requireOnboardingComplete, require('../controllers/virtualAccountController').getVirtualAccounts]);
    assert.equal(handlers.includes(requireLegalCompliance), false);
});

test('KYC status masks document identifiers and excludes stored document assets', async () => {
    const Kyc = require('../models/Kyc');
    const kycController = require('../controllers/kycController');
    const onboardingService = require('../services/onboarding.service');
    const originalFindOne = Kyc.findOne;
    const originalGetState = onboardingService.getStateForResponse;
    const sensitiveNumber = 'NIN-12345678901';
    const document = {
        toObject: () => ({
            _id: 'kyc-1',
            userId: 'user-1',
            tier: 2,
            status: 'pending',
            documentType: 'national-id',
            documentNumber: sensitiveNumber,
            documentImage: 'https://public.example/document.jpg',
            documentPublicId: 'private/document',
            documentResourceType: 'image',
            documentDeliveryType: 'authenticated',
            documentFormat: 'jpg'
        })
    };
    Kyc.findOne = () => ({ sort: async () => document });
    onboardingService.getStateForResponse = async () => ({ currentStep: 'transaction_pin' });

    try {
        const res = {
            statusCode: 200,
            body: null,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; }
        };
        await kycController.getMyKyc({ user: { id: 'user-1' } }, res);
        const serialized = JSON.stringify(res.body);
        assert.equal(res.body.data.documentNumberLast4, '8901');
        assert.equal(serialized.includes(sensitiveNumber), false);
        assert.equal(serialized.includes('documentPublicId'), false);
        assert.equal(serialized.includes('documentImage'), false);
    } finally {
        Kyc.findOne = originalFindOne;
        onboardingService.getStateForResponse = originalGetState;
    }
});

test('completion, support, payment verification, and provider webhook paths remain exempt', () => {
    const auth = require('../routes/auth');
    const kyc = require('../routes/kyc');
    const legal = require('../routes/legal');
    const support = require('../routes/support');
    const wallet = require('../routes/wallet');
    const paystack = require('../routes/paystack');
    const services = require('../routes/services');
    const webhooks = require('../routes/webhooks');
    const onboarding = require('../routes/onboarding');

    for (const [router, path, method] of [
        [auth, '/me', 'get'],
        [auth, '/set-pin', 'post'],
        [auth, '/send-otp', 'post'],
        [auth, '/verify-otp', 'post'],
        [auth, '/email/send-otp', 'post'],
        [auth, '/email/verify-otp', 'post'],
        [kyc, '/submit', 'post'],
        [kyc, '/my-status', 'get'],
        [legal, '/acceptance', 'post'],
        [support, '/create', 'post'],
        [wallet, '/verify', 'get'],
        [paystack, '/verify/:reference', 'get'],
        [services, '/transaction/status', 'post'],
        [webhooks, '/payment/:gatewayCode', 'post'],
        [onboarding, '/status', 'get']
    ]) {
        const handlers = routeHandlers(router, path, method);
        assert.ok(handlers, `${method.toUpperCase()} ${path} route missing`);
        assert.equal(handlers.includes(requireOnboardingComplete), false, `${path} must remain exempt`);
    }
});

test('enrolled incomplete customer is skipped before repository or provider work', async () => {
    const previous = process.env.ONBOARDING_ENFORCEMENT_MODE;
    process.env.ONBOARDING_ENFORCEMENT_MODE = 'new_users';
    let repositoryCalls = 0;
    let gatewayCalls = 0;
    const service = new VirtualAccountService({
        onboarding: {
            getState: async () => ({ enrolled: true, complete: false })
        },
        repository: {
            getUser: async () => { repositoryCalls++; return { _id: 'user-1' }; }
        },
        gatewayService: {
            getGateway: async () => { gatewayCalls++; return null; }
        }
    });

    try {
        const result = await service.provisionEligible({ userId: 'user-1' });
        assert.equal(result.paystack.code, 'ONBOARDING_INCOMPLETE');
        assert.equal(result.monnify.code, 'ONBOARDING_INCOMPLETE');
        assert.equal(repositoryCalls, 0);
        assert.equal(gatewayCalls, 0);

        await assert.rejects(
            () => service.provision({ userId: 'user-1', providerCode: 'paystack', consent: true }),
            error => error.code === 'ONBOARDING_INCOMPLETE' && error.httpStatus === 403
        );
        assert.equal(repositoryCalls, 0);
        assert.equal(gatewayCalls, 0);
    } finally {
        if (previous === undefined) delete process.env.ONBOARDING_ENFORCEMENT_MODE;
        else process.env.ONBOARDING_ENFORCEMENT_MODE = previous;
    }
});

test('off mode preserves legacy provisioning entry behavior without onboarding lookup', async () => {
    const previous = process.env.ONBOARDING_ENFORCEMENT_MODE;
    process.env.ONBOARDING_ENFORCEMENT_MODE = 'off';
    let onboardingCalls = 0;
    let repositoryCalls = 0;
    const service = new VirtualAccountService({
        onboarding: { getState: async () => { onboardingCalls++; } },
        repository: { getUser: async () => { repositoryCalls++; return null; } }
    });

    try {
        const result = await service.provisionEligible({ userId: 'legacy-user' });
        assert.equal(onboardingCalls, 0);
        assert.equal(repositoryCalls, 1);
        assert.equal(result.paystack.code, 'USER_NOT_FOUND');
    } finally {
        if (previous === undefined) delete process.env.ONBOARDING_ENFORCEMENT_MODE;
        else process.env.ONBOARDING_ENFORCEMENT_MODE = previous;
    }
});
