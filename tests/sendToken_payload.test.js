/**
 * SECURITY / CONTRACT REGRESSION TESTS
 * sendToken authenticated-user payload:
 *   - MUST include myReferralCode (prevents first-login dashboard blank code)
 *   - MUST return myReferralCode: null when the user has none
 *   - MUST preserve existing public fields (id/name/email/phone/roles/
 *     isPhoneVerified/isPinSet)
 *   - MUST NOT expose any sensitive/secret fields
 *
 * Run: node tests/sendToken_payload.test.js
 */
process.env.JWT_SECRET = 'test-secret-for-jwt';
const assert = require('assert');
const { sendToken } = require('../utils/authUtils');

function makeRes() {
    const res = {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; if (this.statusCode === null) this.statusCode = 200; return this; },
        cookie() { return this; },
    };
    return res;
}

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

const SENSITIVE_FIELDS = [
    'password',
    'passwordHistory',
    'transactionPin',
    'pinHistory',
    'otp',
    'otpExpires',
    'emailOtp',
    'emailOtpExpires'
];

function assertPayloadSafe(payload) {
    const json = JSON.stringify(payload);
    const leaked = SENSITIVE_FIELDS.filter(k => json.includes(`"${k}"`));
    assert.deepStrictEqual(leaked, [], `sensitive field(s) leaked: ${leaked.join(', ')}`);
}

console.log('====================================================');
console.log('  SENDTOKEN PAYLOAD CONTRACT TESTS');
console.log('====================================================\n');

// ---- 1. Full public shape with a referral code present ----
{
    const res = makeRes();
    sendToken({
        _id: 'USER_123',
        name: 'Jane Doe',
        email: 'jane@example.com',
        phone: '08012345678',
        role: 'user',
        roles: ['user'],
        isPhoneVerified: true,
        isPinSet: false,
        myReferralCode: 'a1b2c3d4'
    }, res);

    const body = res.body;
    test('A. sendToken returns myReferralCode when present', () => {
        assert.strictEqual(body.user.myReferralCode, 'a1b2c3d4');
    });
    test('B. existing id/name/email/phone/roles/isPhoneVerified/isPinSet intact', () => {
        assert.deepStrictEqual(body.user, {
            id: 'USER_123',
            name: 'Jane Doe',
            email: 'jane@example.com',
            phone: '08012345678',
            roles: ['user'],
            isPhoneVerified: true,
            isPinSet: false,
            myReferralCode: 'a1b2c3d4'
        });
    });
    test('C. payload shape is exactly the public allowlist', () => {
        assert.deepStrictEqual(
            Object.keys(body.user).sort(),
            ['email', 'id', 'isPhoneVerified', 'isPinSet', 'myReferralCode', 'name', 'phone', 'roles'].sort()
        );
    });
    test('D. no sensitive fields exposed when referral code present', () => {
        assertPayloadSafe(body.user);
    });
}

// ---- 2. Referral code absent -> null ----
{
    const res = makeRes();
    sendToken({
        _id: 'USER_456',
        name: 'Bob',
        email: 'bob@example.com',
        phone: '08098765432',
        role: 'user',
        roles: ['user'],
        isPhoneVerified: true,
        isPinSet: true
    }, res);

    test('E. sendToken returns myReferralCode null when absent', () => {
        assert.strictEqual(res.body.user.myReferralCode, null);
    });
    test('F. no sensitive fields exposed when referral code absent', () => {
        assertPayloadSafe(res.body.user);
    });
}

// ---- 3. Sensitive fields that exist on the model are stripped ----
{
    const res = makeRes();
    sendToken({
        _id: 'USER_789',
        name: 'Eve',
        email: 'eve@example.com',
        phone: '08011112222',
        role: 'user',
        roles: ['user'],
        isPhoneVerified: true,
        isPinSet: false,
        myReferralCode: 'z9y8x7w6',
        password: 'hashed-secret',
        passwordHistory: ['old-hash-1', 'old-hash-2'],
        transactionPin: 'hashed-pin',
        pinHistory: ['old-pin-hash'],
        otp: '123456',
        otpExpires: new Date(),
        emailOtp: '654321',
        emailOtpExpires: new Date()
    }, res);

    test('G. password/passwordHistory/transactionPin/pinHistory/otp/emailOtp all stripped', () => {
        assertPayloadSafe(res.body.user);
        assert.deepStrictEqual(
            Object.keys(res.body.user).sort(),
            ['email', 'id', 'isPhoneVerified', 'isPinSet', 'myReferralCode', 'name', 'phone', 'roles'].sort()
        );
    });
}

// ---- 4. Legacy role string still merged into roles ----
{
    const res = makeRes();
    sendToken({
        _id: 'USER_LEGACY',
        name: 'Legacy',
        phone: '08000000000',
        role: 'agent',
        isPhoneVerified: true,
        isPinSet: false
    }, res);

    test('H. legacy single `role` still surfaced as roles array', () => {
        assert.deepStrictEqual(res.body.user.roles, ['agent']);
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