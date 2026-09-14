/**
 * LEGAL DISCOVERABILITY — approved web + mobile "Legal & Policies" surface
 *
 * Static check that the authenticated Web Profile and the Mobile Profile
 * expose Terms of Service, Privacy Policy and Refund/Complaints Policy, and
 * that the mobile SUPPORT section no longer duplicates Privacy.
 *
 * All three targets route to the authoritative backend-driven legal pages
 * (LegalDocumentPage / LegalDocumentScreen); no duplicate legal pages exist.
 *
 * Zero-dependency, repo test convention.
 * Run: node tests/legal_discoverability.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const webProfile = path.join(__dirname, '..', '..', 'vtu-web', 'src', 'pages', 'user', 'UserProfilePage.tsx');
const mobileProfile = path.join(__dirname, '..', '..', 'mobile_app', 'src', 'screens', 'profile', 'ProfileScreen.tsx');

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

console.log('====================================================');
console.log('     LEGAL DISCOVERABILITY TESTS');
console.log('====================================================\n');

// ---------------------------------------------------------------
// Web Profile — Legal & Policies group
// ---------------------------------------------------------------
test('web UserProfilePage.tsx exists', () => assert.ok(fs.existsSync(webProfile), `missing ${webProfile}`));
if (fs.existsSync(webProfile)) {
    const src = fs.readFileSync(webProfile, 'utf8');
    test('web Profile has a "Legal & Policies" group', () => {
        assert.ok(/Legal\s*&\s*Policies/i.test(src), 'missing Legal & Policies label');
    });
    test('web Profile links Terms of Service -> /terms', () => {
        assert.match(src, /Terms of Service/);
        assert.ok(src.includes("'/terms'"), 'missing /terms route');
    });
    test('web Profile links Privacy Policy -> /privacy', () => {
        assert.match(src, /Privacy Policy/);
        assert.ok(src.includes("'/privacy'"), 'missing /privacy route');
    });
    test('web Profile links Refund, Reversal & Complaints Policy -> /refund-policy', () => {
        assert.match(src, /Refund, Reversal & Complaints Policy/);
        assert.ok(src.includes("'/refund-policy'"), 'missing /refund-policy route');
    });
}

// ---------------------------------------------------------------
// Mobile Profile — LEGAL & POLICIES rows, no Support duplicate
// ---------------------------------------------------------------
test('mobile ProfileScreen.tsx exists', () => assert.ok(fs.existsSync(mobileProfile), `missing ${mobileProfile}`));
if (fs.existsSync(mobileProfile)) {
    const src = fs.readFileSync(mobileProfile, 'utf8');
    test('mobile Profile has a "LEGAL & POLICIES" section', () => {
        assert.match(src, /LEGAL\s*&\s*POLICIES/i, 'missing LEGAL & POLICIES section header');
    });
    test('mobile Profile navigates to Terms', () => {
        assert.match(src, /Terms of Service/);
        assert.ok(src.includes("navigate('Terms')"), "missing navigate('Terms')");
    });
    test('mobile Profile navigates to PrivacyPolicy', () => {
        assert.match(src, /Privacy Policy/);
        assert.ok(src.includes("navigate('PrivacyPolicy')"), "missing navigate('PrivacyPolicy')");
    });
    test('mobile Profile navigates to RefundPolicy', () => {
        assert.match(src, /Refund, Reversal & Complaints Policy/);
        assert.ok(src.includes("navigate('RefundPolicy')"), "missing navigate('RefundPolicy')");
    });
    test('mobile Profile does NOT duplicate Privacy under SUPPORT', () => {
        const navCount = (src.match(/navigate\('PrivacyPolicy'\)/g) || []).length;
        assert.strictEqual(navCount, 1, `expected exactly 1 PrivacyPolicy navigation, found ${navCount}`);
        const labelCount = (src.match(/"Privacy Policy"/g) || []).length;
        assert.strictEqual(labelCount, 1, `expected exactly 1 "Privacy Policy" row, found ${labelCount}`);
        const supportStart = src.indexOf('title="SUPPORT"');
        const legalStart = src.indexOf('title="LEGAL & POLICIES"');
        const supportSegment = src.slice(supportStart, legalStart);
        assert.ok(!/Privacy Policy/.test(supportSegment), 'SUPPORT section must not contain a Privacy Policy row');
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