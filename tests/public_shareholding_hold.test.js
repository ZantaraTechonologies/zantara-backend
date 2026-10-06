'use strict';

process.env.PUBLIC_SHAREHOLDING_KYC_HOLD = 'true';

const assert = require('assert');
const { readFileSync } = require('fs');
const path = require('path');

const TransactionStatus = require('../models/TransactionStatus');
const investmentRouter = require('../routes/investment');
const investmentService = require('../services/investment.service');
const paymentGatewayService = require('../services/paymentGateway.service');
const requirePublicShareholdingAccess = require('../middlewares/requirePublicShareholdingAccess');
const {
    PUBLIC_SHAREHOLDING_KYC_HOLD,
    PUBLIC_SHAREHOLDING_HOLD_CODE,
    assertPublicShareholdingAvailable
} = require('../config/publicShareholding');

const routeHandlers = (routePath, method) => {
    const layer = investmentRouter.stack.find(item => (
        item.route?.path === routePath && (!method || item.route.methods[method])
    ));
    assert.ok(layer, `${method ? method.toUpperCase() + ' ' : ''}investment route '${routePath}' must exist`);
    return layer.route.stack.map(item => item.handle);
};

const makeResponse = () => ({
    statusCode: 200,
    body: null,
    status(code) {
        this.statusCode = code;
        return this;
    },
    json(body) {
        this.body = body;
        return this;
    }
});

async function run() {
    assert.strictEqual(PUBLIC_SHAREHOLDING_KYC_HOLD, true);
    assert.throws(assertPublicShareholdingAvailable, error => (
        error.code === PUBLIC_SHAREHOLDING_HOLD_CODE && error.statusCode === 503
    ));

    let nextCalled = false;
    const response = makeResponse();
    requirePublicShareholdingAccess({}, response, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(response.statusCode, 503);
    assert.deepStrictEqual(response.body, {
        success: false,
        code: PUBLIC_SHAREHOLDING_HOLD_CODE,
        message: 'Public shareholding services are temporarily unavailable.'
    });

    for (const [routePath, method] of [['/summary', 'get'], ['/history', 'get'], ['/buy', 'post'], ['/exit', 'post'], ['/reinvest', 'post'], ['/redeem', 'post'], ['/withdraw', 'post']]) {
        const handlers = routeHandlers(routePath, method);
        assert.strictEqual(handlers[1], requirePublicShareholdingAccess, `${routePath} must fail closed immediately after authentication`);
    }
    for (const [routePath, method] of [['/admin/overview', 'get'], ['/admin/shareholders', 'get'], ['/admin/exits', 'get'], ['/admin/exits/:id', 'put'], ['/admin/withdrawals', 'get'], ['/admin/withdrawals/:id', 'put'], ['/admin/settings', 'get'], ['/admin/settings', 'put'], ['/admin/payout/trigger', 'post']]) {
        assert.ok(!routeHandlers(routePath, method).includes(requirePublicShareholdingAccess), `${method.toUpperCase()} ${routePath} must remain available to authorized admins`);
    }

    await assert.rejects(
        paymentGatewayService.initializeFunding({
            user: { _id: 'held-user' },
            amount: 10000,
            metadata: { type: 'investment_buy' }
        }),
        error => error.code === PUBLIC_SHAREHOLDING_HOLD_CODE
    );

    const originalFindOne = TransactionStatus.findOne;
    const originalFind = TransactionStatus.find;
    const originalUpdateOne = TransactionStatus.updateOne;
    const originalAdminSettleProcessing = paymentGatewayService.adminSettleProcessing;
    let deferredUpdate;
    try {
        TransactionStatus.findOne = async () => null;
        TransactionStatus.updateOne = async (filter, update) => {
            deferredUpdate = { filter, update };
            return { modifiedCount: 1 };
        };
        const deferred = await paymentGatewayService.finalizeFundingCredit({
            transactionStatus: {
                refId: 'HELD-SETTLEMENT',
                userId: 'held-user',
                type: 'investment_buy',
                status: 'pending',
                provider: 'paystack',
                amountKobo: 10000,
                expectedCurrency: 'NGN'
            },
            gatewayPaymentResult: {
                status: 'success',
                gateway: 'paystack',
                reference: 'HELD-SETTLEMENT',
                providerTransactionId: 'provider-held-settlement',
                amount: 100,
                currency: 'NGN'
            },
            source: 'webhook'
        });
        assert.strictEqual(deferred.status, 'settlement_pending');
        assert.strictEqual(deferred.credited, false);
        assert.strictEqual(deferred.deferred, true);
        assert.deepStrictEqual(deferredUpdate.filter, { refId: 'HELD-SETTLEMENT', status: 'pending' });
        assert.strictEqual(deferredUpdate.update.$set.status, 'settlement_pending');
        assert.strictEqual(deferredUpdate.update.$set.confirmedProviderRef, 'provider-held-settlement');
        assert.strictEqual(deferredUpdate.update.$set.settlementLeaseExpiresAt.getTime(), 0);
    } finally {
        TransactionStatus.findOne = originalFindOne;
        TransactionStatus.updateOne = originalUpdateOne;
    }

    let automaticSettlementCalled = false;
    try {
        TransactionStatus.find = async () => [{ refId: 'HELD-RECOVERY', type: 'investment_buy' }];
        paymentGatewayService.adminSettleProcessing = async () => {
            automaticSettlementCalled = true;
            return { settled: true };
        };
        const recovery = await paymentGatewayService.recoverStrandedSettlements();
        assert.deepStrictEqual(recovery, { scanned: 1, settled: 0, skipped: 1 });
        assert.strictEqual(automaticSettlementCalled, false);
    } finally {
        TransactionStatus.find = originalFind;
        paymentGatewayService.adminSettleProcessing = originalAdminSettleProcessing;
    }

    await assert.rejects(
        investmentService.fulfillSharePurchase('held-user', 1, 'HELD-SHARE-PURCHASE'),
        error => error.code === PUBLIC_SHAREHOLDING_HOLD_CODE
    );

    const settlementSource = readFileSync(path.join(__dirname, '..', 'services', 'paymentGateway.service.js'), 'utf8');
    assert.match(settlementSource, /source === 'admin_reconciliation'/);
    assert.match(settlementSource, /\{ bypassPublicShareholdingHold \}/);
    assert.match(settlementSource, /deferred: finalResult\.deferred/);
    assert.match(settlementSource, /message: finalResult\.message/);

    const withdrawalRoutes = readFileSync(path.join(__dirname, '..', 'routes', 'withdrawal.js'), 'utf8');
    assert.match(withdrawalRoutes, /router\.post\('\/', verifyJWT, requireLegalCompliance, requestWithdrawal\)/);
    assert.doesNotMatch(withdrawalRoutes, /requirePublicShareholdingAccess/);

    console.log('Public shareholding hold tests passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
