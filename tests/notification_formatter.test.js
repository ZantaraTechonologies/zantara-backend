const assert = require('assert');
const {
    formatNairaAmount,
    formatNotificationDateTimeWAT,
    getServiceDisplayName,
    getFundingMethodDisplayName,
    sanitizeCustomerFailureReason,
    safeTransactionReference,
    maskPhone,
    maskIdentifier,
    buildEmailShell,
    buildPurchaseSuccessContent,
    buildPurchaseFailureContent,
    buildFundingSuccessContent,
    GENERIC_FAILURE_MESSAGE,
} = require('../utils/notificationFormatter');

async function runFormatterTests() {
    console.log('====================================================');
    console.log('   NOTIFICATION FORMATTER TEST SUITE (Phase 1)');
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

    const brand = { siteName: 'Zantara', supportEmail: '', supportPhone: '' };

    // ─────────────────────────────────────────────────────
    // AMOUNT FORMATTING
    // ─────────────────────────────────────────────────────
    await test('1. formatNairaAmount renders whole naira with trailing zeros', () => {
        assert.strictEqual(formatNairaAmount(200), '₦200.00');
        assert.strictEqual(formatNairaAmount(1500), '₦1,500.00');
        assert.strictEqual(formatNairaAmount(10000.5), '₦10,000.50');
    });

    await test('2. formatNairaAmount handles 0, negatives and invalid input safely', () => {
        assert.strictEqual(formatNairaAmount(0), '₦0.00');
        assert.strictEqual(formatNairaAmount(-250), '₦-250.00');
        assert.strictEqual(formatNairaAmount(NaN), '₦0.00');
        assert.strictEqual(formatNairaAmount(undefined), '₦0.00');
        assert.strictEqual(formatNairaAmount('500'), '₦500.00');
    });

    // ─────────────────────────────────────────────────────
    // WAT TIMESTAMP
    // ─────────────────────────────────────────────────────
    await test('3. formatNotificationDateTimeWAT renders Africa/Lagos wall time', () => {
        // Fixed instant: 2026-09-15 17:30:00 UTC == 18:30 WAT (UTC+1; no DST in Lagos)
        const fixed = new Date('2026-09-15T17:30:00.000Z');
        assert.strictEqual(formatNotificationDateTimeWAT(fixed), '15 Sep 2026, 6:30 PM WAT');
    });

    await test('4. formatNotificationDateTimeWAT never throws on bad input', () => {
        assert.ok(typeof formatNotificationDateTimeWAT(undefined) === 'string');
        assert.ok(typeof formatNotificationDateTimeWAT('not-a-date') === 'string');
        assert.ok(formatNotificationDateTimeWAT('not-a-date').endsWith('WAT'));
    });

    // ─────────────────────────────────────────────────────
    // SERVICE NAMING (never raw codes / never provider names)
    // ─────────────────────────────────────────────────────
    await test('5. getServiceDisplayName maps airtime/data codes to network + product', () => {
        assert.strictEqual(getServiceDisplayName('airtime', 'mtn'), 'MTN Airtime');
        assert.strictEqual(getServiceDisplayName('data', 'glo-data-1gb'), 'GLO Data Bundle');
        assert.strictEqual(getServiceDisplayName('data', 'AIRTEL_DATA_500MB'), 'Airtel Data Bundle');
    });

    await test('6. getServiceDisplayName falls back to safe labels; never a raw code', () => {
        const name = getServiceDisplayName('electricity', 'ikeja-electric-prepaid');
        assert.strictEqual(name, 'Electricity');
        const unknown = getServiceDisplayName('weirdcat', 's9x-REAL-PROVIDER-INTERNAL-r2d2');
        assert.ok(!unknown.toUpperCase().includes('REAL-PROVIDER'), 'must not contain internal/raw tokens');
        assert.ok(typeof unknown === 'string' && unknown.length > 0);
    });

    // ─────────────────────────────────────────────────────
    // FUNDING METHOD NAMING (never gateways)
    // ─────────────────────────────────────────────────────
    await test('7. getFundingMethodDisplayName never leaks a gateway name', () => {
        const samples = [undefined, 'paystack', 'monnify', 'flutterwave', 'payment-gateway'];
        for (const s of samples) {
            const label = getFundingMethodDisplayName(s);
            for (const g of ['paystack', 'monnify', 'flutterwave']) {
                assert.ok(!label.toLowerCase().includes(g), `${label} leaked gateway ${g}`);
            }
            assert.ok(label.length > 0);
        }
        assert.strictEqual(getFundingMethodDisplayName('card'), 'Card');
        assert.strictEqual(getFundingMethodDisplayName('ussd'), 'USSD');
        assert.strictEqual(getFundingMethodDisplayName('bank_transfer'), 'Bank Transfer');
        assert.strictEqual(getFundingMethodDisplayName('virtual_account'), 'Bank Transfer');
        assert.strictEqual(getFundingMethodDisplayName('paystack'), 'Wallet Funding');
    });

    // ─────────────────────────────────────────────────────
    // FAILURE SANITIZATION
    // ─────────────────────────────────────────────────────
    await test('8. Technical error text is NEVER surfaced in a failure payload', () => {
        const nastyError = 'ECONNRESET provider endpoint internal-code-XYZ failed at 2026-09-15T17:30:00Z secret-db-host:27017';
        const content = buildPurchaseFailureContent({
            type: 'airtime',
            serviceId: 'mtn',
            amount: 500,
            reference: 'ZNT-ABC123',
            reason: new Error(nastyError),
            refunded: true,
            brand,
        });

        const all = [
            content.message,
            content.smsMessage,
            content.emailSubject,
            content.emailHtml,
            content.title,
        ].join('\n');

        for (const token of ['ECONNRESET', 'internal-code-XYZ', 'secret-db-host', '27017']) {
            assert.ok(!all.includes(token), `technical token '${token}' leaked into customer-facing copy`);
        }
        assert.strictEqual(content.message.includes(GENERIC_FAILURE_MESSAGE), true);
    });

    await test('9. Safe controlled failure classes pass through verbatim', () => {
        const reason = new Error('Insufficient wallet balance');
        const content = buildPurchaseFailureContent({
            type: 'data', serviceId: 'mtn-data-1gb', amount: 300,
            reference: 'ZNT-X1', reason, refunded: false, brand,
        });
        assert.ok(content.message.includes('Insufficient wallet balance'));
        assert.ok(content.message.includes('No charge was applied'));
    });

    await test('10. customerMessage override wins and refund claim requires the flag', () => {
        const content = buildPurchaseFailureContent({
            type: 'airtime', serviceId: 'mtn', amount: 100,
            reference: 'ZNT-X2',
            reason: { customerMessage: 'Top-up could not be delivered. Please retry.', message: 'provider refused: E500' },
            refunded: false, brand,
        });
        assert.ok(content.message.includes('Top-up could not be delivered'));
        assert.ok(!content.message.includes('E500'));

        const unRefunded = buildPurchaseFailureContent({
            type: 'airtime', serviceId: 'mtn', amount: 100,
            reference: 'ZNT-X2', reason: 'boom', refunded: false, brand,
        });
        assert.ok(unRefunded.message.includes('No charge was applied'));
        assert.ok(!unRefunded.message.includes('refunded'));

        const refunded = buildPurchaseFailureContent({
            type: 'airtime', serviceId: 'mtn', amount: 100,
            reference: 'ZNT-X2', reason: 'boom', refunded: true, brand,
        });
        assert.ok(refunded.message.includes('refunded'));
    });

    // ─────────────────────────────────────────────────────
    // IDENTIFIER MASKING / REFERENCES
    // ─────────────────────────────────────────────────────
    await test('11. maskPhone and maskIdentifier hide the middle of identifiers', () => {
        assert.strictEqual(maskPhone('08031234567'), '080****4567');
        assert.strictEqual(maskIdentifier('11223344556'), '112****4556');
        assert.strictEqual(maskPhone(''), '****');
    });

    await test('12. safeTransactionReference strips newline injection', () => {
        assert.strictEqual(safeTransactionReference('ZNT-REF\nXSS\r\nINJECT'), 'ZNT-REF XSS INJECT');
        assert.strictEqual(safeTransactionReference(undefined), '');
    });

    // ─────────────────────────────────────────────────────
    // SUCCESS PAYLOAD CONTENT
    // ─────────────────────────────────────────────────────
    await test('13. Success payload masks the recipient phone and shows clean copy', () => {
        const content = buildPurchaseSuccessContent({
            type: 'data',
            serviceId: 'mtn-data-1gb',
            amount: 1000,
            reference: 'ZNT-SUCC-1',
            details: { phone: '08055555555' },
            brand,
            greetingName: 'Ada',
        });
        assert.ok(content.message.includes('MTN Data Bundle purchased successfully'));
        assert.ok(content.message.includes('₦1,000.00'));
        assert.strictEqual(content.message.includes('08055555555'), false, 'full phone must not appear');
        assert.ok(content.message.includes('080****5555'));
        assert.ok(content.emailHtml.includes('was successful'));
        assert.ok(!content.emailHtml.includes('CAC') && !content.emailHtml.includes('RC'));
    });

    // ─────────────────────────────────────────────────────
    // FUNDING PAYLOAD CONTENT
    // ─────────────────────────────────────────────────────
    await test('14. Funding success copy uses method label and never a gateway', () => {
        const content = buildFundingSuccessContent({
            amount: 5000,
            method: 'paystack-card',
            reference: 'ZNT-FUND-1',
            brand,
        });
        assert.ok(content.message.includes('₦5,000.00'));
        for (const g of ['paystack', 'monnify', 'flutterwave']) {
            assert.ok(!content.message.toLowerCase().includes(g), `${g} leaked into funding copy`);
        }
        assert.ok(content.emailHtml.includes('Wallet Funded Successfully'));
    });

    // ─────────────────────────────────────────────────────
    // EMAIL SHELL BRANDING
    // ─────────────────────────────────────────────────────
    await test('15. Blank support/brand fields are omitted from the email shell', () => {
        const html = buildEmailShell({ siteName: 'Zantara', supportEmail: '', supportPhone: '', siteUrl: '' }, {
            title: 'Test', bodyHtml: '<p>body</p>',
        });
        assert.ok(html.includes('Zantara'));
        assert.ok(!html.includes('http'));

        const withSupport = buildEmailShell({ siteName: 'Zantara', supportEmail: 'help@zantara.example' }, {
            title: 'Test', bodyHtml: '<p>body</p>',
        });
        assert.ok(withSupport.includes('help@zantara.example'));
    });

    console.log('\n----------------------------------------------------');
    console.log(`Test Execution Finished: ${passed} PASSED, ${failed} FAILED.`);
    console.log('----------------------------------------------------\n');

    process.exit(failed > 0 ? 1 : 0);
}

runFormatterTests();