/**
 * SECURITY / CONTRACT REGRESSION TESTS
 * Customer transaction DTO sanitization:
 *   - serializeCustomerTransaction / serializeCustomerTransactions
 *   - getUserTransactions / getUserTransaction controllers
 *   - getUserTransaction WalletLedger REFERRAL_SKIPPED synthesis
 *   - getDividendHistory
 *
 * Run: node tests/customer_transaction_dto.test.js
 */
process.env.JWT_SECRET = 'test-secret-for-jwt';
const assert = require('assert');

const {
    serializeCustomerTransaction,
    serializeCustomerTransactions,
} = require('../utils/customerTransactionSerializer');

// ---- Runner (zero-dependency, matches repo test convention) ----
let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
    try {
        fn();
        console.log(`  [PASS] ${name}`);
        passed++;
    } catch (err) {
        console.error(`  [FAIL] ${name}`);
        console.error(`         ${err.message}`);
        failures.push(`${name}: ${err.message}`);
        failed++;
    }
}

const BLOCKED = [
    'costPrice',
    'estimatedCostPrice',
    'actualCostPrice',
    'profit',
    'estimatedProfit',
    'actualProfit',
    'vendorCommission',
    'providerUnitPrice',
    'convenienceFee',
    'accountingSource',
    'provider',
    'providerRef',
    'response',
    'pricingSnapshot',
    'isLoss',
    'commission',
    'agentPrice',
    'userRole',
    'netProfitAfterCommission',
    'commissionVersion',
];

function assertNoBlocked(obj, label) {
    const json = JSON.stringify(obj);
    const leaked = BLOCKED.filter(k => {
        // match top-level or nested uses like "costPrice": value but not
        // "estimatedCostPrice" false-positive from "estimatedCostPrice"
        const pattern = new RegExp(`"${k}":`);
        return pattern.test(json);
    });
    assert.deepStrictEqual(leaked, [], `${label} leaked blocked field(s): ${leaked.join(', ')}`);
}

const FULL_DOC = {
    _id: 'txn-1',
    userId: 'user-1',
    transactionId: 'ZNT-988-AF2',
    refId: 'ZNT-988-AF2',
    type: 'airtime',
    service: 'mtnairtime',
    amount: 200,
    status: 'success',
    createdAt: new Date('2026-09-11T16:14:23.000Z'),
    updatedAt: new Date('2026-09-11T16:14:24.000Z'),
    costPrice: 185,
    estimatedCostPrice: 185,
    actualCostPrice: 182.5,
    profit: 17.5,
    estimatedProfit: 15,
    actualProfit: 17.5,
    vendorCommission: 2.5,
    providerUnitPrice: 180,
    convenienceFee: 10,
    accountingSource: 'actual',
    provider: 'VTPass',
    providerRef: 'vtp-99221',
    response: { product_name: 'MTN Airtime', token: 'PRIVATE_TOK_1' },
    pricingSnapshot: {
        providerId: 'prov-1',
        providerOfferId: 'offer-1',
        baseCostPrice: 180,
        salePrice: 200,
        retailPrice: 210,
        profit: 20,
        markupValue: 11.1,
        appliedPricingRuleId: 'rule-1'
    },
    isLoss: false,
    commission: 1.75,
    agentPrice: 200,
    userRole: 'user',
    netProfitAfterCommission: 15.75,
    commissionVersion: 'v1',
    __v: 0,
    details: {
        phone: '08031234567',
        network: 'MTN',
        roles: ['user'],
        originalAmount: 200,
        request_id: 'ZNT-988-AF2',
        internalNote: 'admin internal'
    }
};

console.log('====================================================');
console.log('  CUSTOMER TRANSACTION DTO CONTRACT TESTS');
console.log('====================================================\n');

// ---- 1. Core allowlist ----
{
    const dto = serializeCustomerTransaction(FULL_DOC);
    test('A. preserves required public fields', () => {
        assert.strictEqual(dto._id, 'txn-1');
        assert.strictEqual(dto.transactionId, 'ZNT-988-AF2');
        assert.strictEqual(dto.refId, 'ZNT-988-AF2');
        assert.strictEqual(dto.type, 'airtime');
        assert.strictEqual(dto.service, 'mtnairtime');
        assert.strictEqual(dto.amount, 200);
        assert.strictEqual(dto.status, 'success');
        assert.ok(dto.createdAt instanceof Date || typeof dto.createdAt === 'string');
        assert.strictEqual(dto.currency, 'NGN');
    });
    test('B. accounting/cost/profit fields absent', () => {
        assertNoBlocked(dto, 'airtime DTO');
    });
    test('C. pricingSnapshot absent entirely (no providerId/offerId)', () => {
        assert.strictEqual(dto.pricingSnapshot, undefined);
        assertNoBlocked(dto, 'pricing snapshot check');
    });
    test('D. raw provider response absent', () => {
        assert.strictEqual(dto.response, undefined);
    });
    test('E. safe airtime details survive, internal details stripped', () => {
        assert.deepStrictEqual(dto.details, { phone: '08031234567', network: 'MTN' });
    });
    test('F. internal note / roles / originalAmount not in details', () => {
        const json = JSON.stringify(dto);
        assert.ok(!json.includes('internalNote'), 'internalNote leaked');
        assert.ok(!json.includes('originalAmount'), 'originalAmount leaked');
        assert.ok(!json.includes('request_id'), 'request_id leaked');
    });
}

// ---- 2. Category-specific details allowlists ----
{
    const dataDoc = serializeCustomerTransaction({ ...FULL_DOC, type: 'data', details: { phone: '0801', serviceID: 'data-1', variation_code: '1GB', roles: ['user'], originalAmount: 100 } });
    const elecDoc = serializeCustomerTransaction({ ...FULL_DOC, type: 'electricity', details: { meter_number: '12345678901', meter_type: 'prepaid', phone: '0802', roles: ['user'] } });
    const cableDoc = serializeCustomerTransaction({ ...FULL_DOC, type: 'cable', details: { serviceID: 'dstv', billersCode: '12345608', variation_code: 'Y2026', roles: ['user'] } });
    const pinDoc = serializeCustomerTransaction({ ...FULL_DOC, type: 'exam_pin', details: { serviceID: 'waec', variation_code: 'PIN', quantity: 2, billersCode: '0803', roles: ['user'], originalAmount: 200 } });
    const transferDoc = serializeCustomerTransaction({ ...FULL_DOC, type: 'transfer_out', details: { recipientName: 'Ada', recipientPhone: '0804', remarks: 'for lunch', roles: ['user'] } });

    test('G. data details: phone/serviceID/variation_code, no internals', () => {
        assert.deepStrictEqual(dataDoc.details, { phone: '0801', serviceID: 'data-1', variation_code: '1GB' });
        assertNoBlocked(dataDoc, 'data DTO');
    });
    test('H. electricity details safe (incl. purchased token)', () => {
        assert.deepStrictEqual(elecDoc.details, { meter_number: '12345678901', meter_type: 'prepaid', phone: '0802', token: 'PRIVATE_TOK_1' });
    });
    test('H2. electricity purchased token survives in safe details from response', () => {
        const tokenDoc = serializeCustomerTransaction({
            ...FULL_DOC,
            type: 'electricity',
            details: { meter_number: '123', meter_type: 'prepaid', phone: '0802', roles: ['user'] },
            response: { content: { transactions: [{ token: 'ABCD-1234-EFGH' }] }, vendorNote: 'secret-internal' }
        });
        assert.strictEqual(tokenDoc.details.token, 'ABCD-1234-EFGH');
        assert.ok(!JSON.stringify(tokenDoc).includes('vendorNote'), 'vendorNote leaked');
        assert.ok(!JSON.stringify(tokenDoc).includes('"response"'), 'raw response leaked');
    });
    test('H3. token with no safe details still surfaces alone', () => {
        const tokenDoc = serializeCustomerTransaction({
            ...FULL_DOC,
            type: 'electricity',
            details: { roles: ['user'] },
            response: { mainToken: 'TOK-999' }
        });
        assert.deepStrictEqual(tokenDoc.details, { token: 'TOK-999' });
    });
    test('I. cable details safe', () => {
        assert.deepStrictEqual(cableDoc.details, { serviceID: 'dstv', billersCode: '12345608', variation_code: 'Y2026' });
    });
    test('J. exam pin details: serviceID/quantity safe, originalAmount stripped', () => {
        assert.deepStrictEqual(pinDoc.details, { serviceID: 'waec', variation_code: 'PIN', quantity: 2, billersCode: '0803' });
    });
    test('K. transfer details safe', () => {
        assert.deepStrictEqual(transferDoc.details, { recipientName: 'Ada', recipientPhone: '0804', remarks: 'for lunch' });
    });
    test('L. unknown/empty type gets no details object', () => {
        const d = serializeCustomerTransaction({ ...FULL_DOC, type: 'settlement', details: { costPrice: 1, roles: ['user'] } });
        assert.deepStrictEqual(d.details, undefined);
    });
}

// ---- 3. Array serialization + synthetic ledger record ----
{
    const txs = serializeCustomerTransactions([FULL_DOC, { ...FULL_DOC, _id: 'txn-2', type: 'funding', details: { channel: 'paystack' } }]);
    test('M. array serializer returns plain array, all safe', () => {
        assert.strictEqual(txs.length, 2);
        assertNoBlocked(txs, 'array DTO');
    });
    test('N. missing/invalid docs filtered', () => {
        const r = serializeCustomerTransactions([null, undefined, 42, FULL_DOC]);
        assert.strictEqual(r.length, 1);
    });
}

// ---- 4. getUserTransaction WalletLedger REFERRAL_SKIPPED synthesis ----
{
    const tc = require('../controllers/transactionController');
    const legs = [];

    function makeRes() {
        const res = {
            statusCode: null,
            body: null,
            status(c) { this.statusCode = c; return this; },
            json(p) { this.body = p; if (this.statusCode === null) this.statusCode = 200; return this; },
        };
        return res;
    }

    const skipMongoId = '507f1f77bcf86cd799439011';

    test('O. synthetic referral_skipped record uses safe fields only', async () => {
        const originalFindOne = require('../models/Transaction').findOne;
        const originalLedgerFind = require('../models/WalletLedger').findOne;

        require('../models/Transaction').findOne = async () => null;
        require('../models/WalletLedger').findOne = async () => ({
            _id: skipMongoId,
            userId: 'user-1',
            reference: 'ZNT-880-SKIP',
            source: 'REFERRAL_SKIPPED',
            createdAt: new Date('2026-09-01T10:00:00.000Z'),
            metadata: {
                parentTxnId: 'ZNT-880',
                buyerRole: 'user',
                wasCapped: true,
                internalVendor: 'VTPass',
                request: { raw: 'should-never-leak' }
            }
        });

        const req = { user: { id: 'user-1' }, params: { id: skipMongoId } };
        const res = makeRes();
        await tc.getUserTransaction(req, res);

        require('../models/Transaction').findOne = originalFindOne;
        require('../models/WalletLedger').findOne = originalLedgerFind;

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.type, 'referral_skipped');
        assert.strictEqual(res.body.refId, 'ZNT-880-SKIP');
        assert.strictEqual(res.body.transactionId, 'ZNT-880');
        assert.strictEqual(res.body.amount, 0);
        assert.strictEqual(res.body.status, 'skipped');
        assert.ok(!JSON.stringify(res.body).includes('internalVendor'), 'internalVendor leaked from synthetic metadata');
        assert.ok(!JSON.stringify(res.body).includes('raw'), 'raw request leaked from synthetic metadata');
    });

    test('P. legacy file-level model restoration', async () => {
        const Transaction = require('../models/Transaction');
        const WalletLedger = require('../models/WalletLedger');
        assert.strictEqual(typeof Transaction.findOne, 'function');
        assert.strictEqual(typeof WalletLedger.findOne, 'function');
    });
}

// ---- 5. Admin endpoint remains unsanitized ----
{
    const tc = require('../controllers/transactionController');
    const doc = { ...FULL_DOC };
    const originalFindOne = require('../models/Transaction').findOne;
    require('../models/Transaction').findOne = async () => doc;

    const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; if (this.statusCode === null) this.statusCode = 200; return this; } };
    const req = { user: { id: 'user-1' }, params: { id: 'txn-1' } };

    test('Q. admin flows (sanitize:false) still receive full internal doc', async () => {
        await tc.getUserTransaction(req, res, { sanitize: false });
        assert.strictEqual(res.body.costPrice, 185);
        assert.strictEqual(res.body.profit, 17.5);
        assert.ok(res.body.pricingSnapshot, 'pricingSnapshot missing for admin');
        assert.ok(res.body.response, 'response missing for admin');
        require('../models/Transaction').findOne = originalFindOne;
    });
}

console.log('\n====================================================');
console.log(`  RESULT: ${passed} passed, ${failed} failed`);
if (failures.length) {
    console.log('  Failures:');
    failures.forEach(f => console.log(`    - ${f}`));
}
console.log('====================================================');
process.exit(failed ? 1 : 0);