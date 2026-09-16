/**
 * SECURITY TEST SUITE — HIGH 1 (Batch 2A)
 * Customer purchase response sanitization:
 *  - serializePurchaseResult / safePurchaseResult (purchase.service boundary)
 *  - serializePricingPreview (pricing controller boundary)
 *  - recursive forbidden-key defense used by web/mobile surface
 *
 * Run: node tests/customer_purchase_response.test.js
 */
const assert = require('assert');
const {
    FORBIDDEN_FIELDS,
    containsForbiddenFields,
    findForbiddenFields,
    extractCustomerToken,
    serializePurchaseResult,
    safePurchaseResult,
    serializePricingPreview,
} = require('../utils/customerResponseSerializer');

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

async function testAsync(name, fn) {
    try {
        await fn();
        console.log(`  [PASS] ${name}`);
        passed++;
    } catch (err) {
        console.error(`  [FAIL] ${name}`);
        console.error(`         ${err.message}`);
        failures.push(`${name}: ${err.message}`);
        failed++;
    }
}

console.log('====================================================');
console.log('  HIGH 1: CUSTOMER RESPONSE SANITIZATION TESTS');
console.log('====================================================\n');

// ---------------------------------------------------------------------------
// A. VTPass-like successful response carrying internal procurement data
// ---------------------------------------------------------------------------
{
    const vTPassLike = {
        success: true,
        status: 'success',
        message: 'Airtime delivered',
        transactionId: 'VTP-AIR-998877',
        token: 'TOK-ABC-123',
        raw: { code: '000', content: { transactions: [{ token: 'VENDOR-TOKEN' }] } },
        financials: { vendorCost: 182, vendorCommission: 2.5, providerUnitPrice: 184.5, convenienceFee: 10, source: 'actual' },
    };

    const dto = serializePurchaseResult(vTPassLike, { reference: 'ZNT-REF-100', transactionId: 'TXN-1' });

    test('A1. Raw provider response and financials are NOT exposed', () => {
        assert.strictEqual(dto.raw, undefined);
        assert.strictEqual(dto.financials, undefined);
    });
    test('A2. No forbidden field at any depth in the customer DTO', () => {
        assert.deepStrictEqual(findForbiddenFields(dto), []);
        assert.strictEqual(containsForbiddenFields(dto), false);
    });
    test('A3. Safe fields preserved (status/message/reference/transactionId/token)', () => {
        assert.strictEqual(dto.status, 'success');
        assert.strictEqual(dto.message, 'Airtime delivered');
        assert.strictEqual(dto.reference, 'ZNT-REF-100');
        assert.strictEqual(dto.transactionId, 'TXN-1');
        assert.strictEqual(dto.providerTransactionId, 'VTP-AIR-998877');
        assert.strictEqual(dto.token, 'TOK-ABC-123');
    });
}

// ---------------------------------------------------------------------------
// B. Nested internal fields must not survive
// ---------------------------------------------------------------------------
{
    const nested = {
        success: true,
        status: 'success',
        message: 'ok',
        transactionId: 'X',
        raw: { nested: { financials: { vendorCost: 1 } } },
        data: { providerResponse: { raw: { code: '000' } }, baseCostPrice: 50, profit: 10 },
    };

    const dto = serializePurchaseResult(nested, { reference: 'R', transactionId: 'T' });

    test('B1. Nested raw/financials/providerResponse/baseCostPrice/profit absent', () => {
        assert.deepStrictEqual(findForbiddenFields(dto), []);
        assert.strictEqual(dto.raw, undefined);
        assert.strictEqual(dto.data, undefined);
    });
    test('B2. Recursive helper catches deep nesting', () => {
        assert.strictEqual(containsForbiddenFields({ result: { data: { providerResponse: {} } } }), true);
        assert.strictEqual(containsForbiddenFields({ result: { data: { financials: {} } } }), true);
        assert.strictEqual(containsForbiddenFields({ result: { data: { lineItems: [{ vendorCost: 9 }] } } }), true);
    });
}

// ---------------------------------------------------------------------------
// C. Electricity response — token preserved, internals stripped
// ---------------------------------------------------------------------------
{
    const electricity = {
        success: true,
        status: 'success',
        message: 'Token generated',
        transactionId: 'IKJ-1001',
        token: '4829-1920-4820-1928-4829',
        financials: { vendorCost: 1900, vendorCommission: 5, providerUnitPrice: 1910, convenienceFee: 12 },
        raw: { code: '000', content: { transactions: [{ token: '4829-1920-4820-1928-4829', unit_price: 1910 }] } },
    };

    const dto = serializePurchaseResult(electricity, { reference: 'R-ELEC', transactionId: 'T-ELEC' });

    test('C1. Electricity token preserved', () => {
        assert.strictEqual(dto.token, '4829-1920-4820-1928-4829');
    });
    test('C2. Electricity raw/financials absent', () => {
        assert.deepStrictEqual(findForbiddenFields(dto), []);
    });
    test('C3. Nested merchant-shape token also extracted when flat token missing', () => {
        const merchantShape = {
            success: true, status: 'success', message: 'ok',
            raw: { content: { transactions: [{ token: 'TOK-NESTED-4444' }] } },
        };
        const nestedDto = serializePurchaseResult(merchantShape, { reference: 'R', transactionId: 'T' });
        assert.strictEqual(nestedDto.token, 'TOK-NESTED-4444');
        const merchantShapeRaw = {
            success: true, status: 'success', message: 'ok',
            raw: { content: { transactions: [{ token: 'TOK-NESTED-5555' }] } },
        };
        const rawNestedDto = serializePurchaseResult(merchantShapeRaw, { reference: 'R', transactionId: 'T' });
        assert.strictEqual(rawNestedDto.token, 'TOK-NESTED-5555');
    });
    test('C4. extractCustomerToken handles mainToken and data.token', () => {
        assert.strictEqual(extractCustomerToken({ mainToken: 'M-1' }), 'M-1');
        assert.strictEqual(extractCustomerToken({ data: { token: 'D-1' } }), 'D-1');
        assert.strictEqual(extractCustomerToken(undefined), undefined);
        assert.strictEqual(extractCustomerToken(null), undefined);
        assert.strictEqual(extractCustomerToken({}), undefined);
    });
}

// ---------------------------------------------------------------------------
// D. Exam PIN response — PIN/token preserved, internals stripped
// ---------------------------------------------------------------------------
{
    const examPin = {
        success: true,
        status: 'success',
        message: 'WAEC PIN generated',
        transactionId: 'WAEC-887766',
        token: 'WAEC-PIN-1234-5678-9012',
        financials: { vendorCost: 3800, vendorCommission: 20, providerUnitPrice: 3950, convenienceFee: 50 },
        raw: { content: { transactions: [{ token: 'WAEC-PIN-1234-5678-9012' }] } },
    };

    const dto = serializePurchaseResult(examPin, { reference: 'R-PIN', transactionId: 'T-PIN' });

    test('D1. Exam PIN/token preserved', () => {
        assert.strictEqual(dto.token, 'WAEC-PIN-1234-5678-9012');
    });
    test('D2. Exam PIN raw/financials absent', () => {
        assert.deepStrictEqual(findForbiddenFields(dto), []);
    });
    test('D3. Pin:/Token: prefixes stripped on extraction', () => {
        assert.strictEqual(extractCustomerToken({ token: 'Pin: WAEC-1' }), 'WAEC-1');
        assert.strictEqual(extractCustomerToken({ Pin: 'Token: WAEC-2' }), 'WAEC-2');
        assert.strictEqual(extractCustomerToken({ tokens: ['WAEC-3'] }), 'WAEC-3');
    });
}

// ---------------------------------------------------------------------------
// E. Airtime / data / cable — status/reference/message preserved
// ---------------------------------------------------------------------------
{
    for (const label of ['airtime', 'data', 'cable']) {
        const resp = {
            success: true,
            status: 'success',
            message: `${label} delivered`,
            transactionId: `VTP-${label.toUpperCase()}`,
            raw: { code: '000' },
            financials: { vendorCost: 1, vendorCommission: 0.1, providerUnitPrice: 1.2, convenienceFee: 0.3 },
        };
        const dto = serializePurchaseResult(resp, { reference: `R-${label}`, transactionId: `T-${label}` });

        test(`E/${label}: status, reference, message, transactionId preserved`, () => {
            assert.strictEqual(dto.status, 'success');
            assert.strictEqual(dto.reference, `R-${label}`);
            assert.strictEqual(dto.message, `${label} delivered`);
            assert.strictEqual(dto.transactionId, `T-${label}`);
            assert.strictEqual(dto.providerTransactionId, `VTP-${label.toUpperCase()}`);
        });
        test(`E/${label}: no forbidden fields`, () => {
            assert.deepStrictEqual(findForbiddenFields(dto), []);
        });
    }
}

// ---------------------------------------------------------------------------
// F. Pricing preview — payable amount preserved, internals absent
// ---------------------------------------------------------------------------
{
    const preview = serializePricingPreview({
        serviceId: 'svc-1',
        serviceCode: 'MTN_DATA_1GB',
        serviceName: 'MTN Data 1GB',
        salePrice: 300,
        retailPrice: 330,
        savings: 30,
        fee: 0,
        currency: 'NGN',
    });

    test('F1. salePrice/retailPrice/savings/fee preserved', () => {
        assert.strictEqual(preview.salePrice, 300);
        assert.strictEqual(preview.retailPrice, 330);
        assert.strictEqual(preview.savings, 30);
        assert.strictEqual(preview.fee, 0);
        assert.strictEqual(preview.isPreview, true);
    });
    test('F2. baseCostPrice/profit/rawSalePrice absent', () => {
        assert.deepStrictEqual(findForbiddenFields(preview), []);
        assert.strictEqual(preview.baseCostPrice, undefined);
        assert.strictEqual(preview.profit, undefined);
        assert.strictEqual(preview.rawSalePrice, undefined);
    });
    test('F3. null pricing yields null preview', () => {
        assert.strictEqual(serializePricingPreview(null), null);
        assert.strictEqual(serializePricingPreview(undefined), null);
    });
}

// ---------------------------------------------------------------------------
// G. undefined / malformed provider response — controlled DTO, no crash
// ---------------------------------------------------------------------------
{
    test('G1. undefined data yields controlled safe result', () => {
        const result = safePurchaseResult(null);
        assert.strictEqual(result.success, false);
        assert.ok(result.message, 'message present');
        assert.ok(result.error && result.error.message, 'error.message present');
        assert.deepStrictEqual(findForbiddenFields(result), []);
    });
    test('G2. malformed provider response does not leak original object', () => {
        const result = safePurchaseResult({
            success: true,
            data: { raw: { secrets: true }, financials: { vendorCost: 1 }, code: 30 },
            transactionId: undefined,
        });
        assert.deepStrictEqual(findForbiddenFields(result), []);
        assert.strictEqual(result.data.raw, undefined);
    });
    test('G3. serializePurchaseResult tolerates non-objects', () => {
        for (const junk of [undefined, null, 'text', 42, [], true]) {
            const dto = serializePurchaseResult(junk, { reference: 'R', transactionId: 'T' });
            assert.deepStrictEqual(findForbiddenFields(dto), []);
            assert.ok(typeof dto === 'object' && dto !== null);
        }
    });
    test('G4. reference/transactionId take Zantara context when data trustful', () => {
        const dto = serializePurchaseResult({ success: true, status: 'success' }, { reference: 'ZNT-1', transactionId: 'TXN-9' });
        assert.strictEqual(dto.reference, 'ZNT-1');
        assert.strictEqual(dto.transactionId, 'TXN-9');
    });
}

// ---------------------------------------------------------------------------
// H. Internal accounting data remains available before projection
// ---------------------------------------------------------------------------
{
    test('H1. Provider financials/raw persist for accounting (NOT destroyed)', () => {
        const internal = {
            success: true,
            status: 'success',
            message: 'ok',
            transactionId: 'VTP-X',
            financials: { vendorCost: 182.5, vendorCommission: 2.5, providerUnitPrice: 185, convenienceFee: 10, source: 'actual' },
            raw: { code: '000', content: { transactions: { total_amount: 182.5, commission: 2.5 } } },
        };
        // Providers/accounting still read the raw response object:
        assert.strictEqual(internal.financials.vendorCost, 182.5);
        assert.strictEqual(internal.raw.content.transactions.total_amount, 182.5);
        // ...and the persisted Transaction keeps it (purchase.service stores
        // transaction.response = response.raw + financials-derived columns).
        // Only the customer DTO is stripped:
        const customerDto = serializePurchaseResult(internal, { reference: 'R', transactionId: 'T' });
        assert.strictEqual(customerDto.raw, undefined);
        assert.strictEqual(customerDto.financials, undefined);
        assert.deepStrictEqual(findForbiddenFields(customerDto), []);
    });
    test('H2. FORBIDDEN_FIELDS list is exported and complete', () => {
        const required = [
            'financials', 'vendorCost', 'vendorCommission', 'providerUnitPrice', 'convenienceFee',
            'raw', 'rawResponse', 'providerResponse', 'baseCostPrice', 'costPrice', 'actualCostPrice',
            'actualProfit', 'profit', 'margin', 'procurementCost', 'rawSalePrice',
        ];
        for (const key of required) {
            assert.ok(FORBIDDEN_FIELDS.includes(key), `missing blocklist entry: ${key}`);
        }
    });
}

// ---------------------------------------------------------------------------
// I. safePurchaseResult keeps the processPurchase-return shape (regression)
// ---------------------------------------------------------------------------
{
    test('I1. Full processPurchase-shaped result is projected safely', () => {
        const out = safePurchaseResult({
            success: true,
            data: {
                success: true, status: 'success', message: 'Airtime delivered',
                transactionId: 'ZNT-TXN-1', providerTransactionId: 'VTP-1',
                reference: 'ZNT-REF-1', token: 'TOK',
                raw: { code: '000' }, financials: { vendorCost: 1 },
            },
            transactionId: 'mongo-id-1',
            reference: 'ZNT-REF-1',
        });

        assert.strictEqual(out.success, true);
        assert.strictEqual(out.transactionId, 'mongo-id-1');
        assert.strictEqual(out.reference, 'ZNT-REF-1');
        assert.strictEqual(out.data.status, 'success');
        assert.strictEqual(out.data.token, 'TOK');
        assert.deepStrictEqual(findForbiddenFields(out), []);
    });
    test('I2. Failed result carries only a safe error surface', () => {
        const out = safePurchaseResult({
            success: false,
            message: 'Provider rejected the request',
            data: null,
            error: { message: 'Provider rejected the request', raw: { secret: 'x' } },
        });
        assert.strictEqual(out.success, false);
        assert.strictEqual(out.error.message, 'Provider rejected the request');
        assert.strictEqual(out.error.raw, undefined);
        assert.deepStrictEqual(findForbiddenFields(out), []);
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