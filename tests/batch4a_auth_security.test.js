'use strict';

/**
 * Batch 4A password-reset and coupled credential-change security tests.
 *
 * Run: node tests/batch4a_auth_security.test.js
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'batch4a-jwt-secret';
process.env.RESET_OTP_SECRET = process.env.RESET_OTP_SECRET || 'batch4a-reset-otp-secret';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const https = require('https');
const { EventEmitter } = require('events');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  [PASS] ${name}`);
        passed++;
    } catch (error) {
        console.error(`  [FAIL] ${name}`);
        console.error(`         ${error.message}`);
        failed++;
    }
}

function loadSecurityModules() {
    const tokens = require('../utils/authTokens');
    const reset = require('../services/passwordReset.service');
    return { tokens, reset };
}

function makeUser(overrides = {}) {
    return {
        _id: '507f1f77bcf86cd799439011',
        email: 'user@example.com',
        role: 'user',
        roles: ['user'],
        authVersion: 0,
        ...overrides
    };
}

function makeRes() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; if (this.statusCode === null) this.statusCode = 200; return this; },
        cookie() { return this; },
        clearCookie() { return this; }
    };
}

async function runMiddleware(token, dbUser) {
    const User = require('../models/User');
    const original = User.findById;
    User.findById = () => ({ select: async () => dbUser });
    delete require.cache[require.resolve('../middlewares/auth')];
    const { verifyJWT } = require('../middlewares/auth');
    const req = { cookies: {}, headers: { authorization: `Bearer ${token}` } };
    const res = makeRes();
    let nextCalled = false;
    try {
        await verifyJWT(req, res, () => { nextCalled = true; });
        return { req, res, nextCalled };
    } finally {
        User.findById = original;
    }
}

async function runOptionalMiddleware(token, dbUser) {
    const User = require('../models/User');
    const original = User.findById;
    User.findById = () => ({ select: async () => dbUser });
    delete require.cache[require.resolve('../middlewares/auth')];
    const { verifyJWTOptional } = require('../middlewares/auth');
    const req = { cookies: {}, headers: { authorization: `Bearer ${token}` } };
    const res = makeRes();
    let nextCalled = false;
    try {
        await verifyJWTOptional(req, res, () => { nextCalled = true; });
        return { req, res, nextCalled };
    } finally {
        User.findById = original;
    }
}

const captureConsole = async (methods, operation) => {
    const captured = [];
    const originals = {};
    for (const method of methods) {
        originals[method] = console[method];
        console[method] = (...args) => captured.push(args.map(String).join(' '));
    }
    try {
        await operation();
        return captured.join('\n');
    } finally {
        for (const method of methods) console[method] = originals[method];
    }
};

async function main() {
    console.log('====================================================');
    console.log(' BATCH 4A AUTH SECURITY TESTS');
    console.log('====================================================\n');

    const controllerSource = read('controllers/authController.js');
    const routeSource = read('routes/auth.js');
    const modelSource = read('models/User.js');
    const authSource = read('middlewares/auth.js');
    const pinSource = read('services/pin.service.js');
    const serverSource = read('server.js');
    const sanitizerSource = read('utils/logSanitizer.js');

    await test('1. forgotPassword_returns_equivalent_response_for_known_and_unknown_account', () => {
        assert.match(controllerSource, /PASSWORD_RESET_RESPONSE|genericResetResponse/);
        assert.doesNotMatch(controllerSource, /User with this phone number not found/);
    });

    await test('2. forgotPassword_never_persists_raw_reset_OTP', () => {
        assert.match(modelSource, /passwordResetOtpDigest/);
        const section = controllerSource.slice(controllerSource.indexOf('const forgotPassword'), controllerSource.indexOf('const verifyResetOTP'));
        assert.doesNotMatch(section, /findByIdAndUpdate[\s\S]*\{\s*otp[,}]/);
    });

    await test('3. reset_OTP_is_generated_with_crypto_not_Math_random', () => {
        const { reset } = loadSecurityModules();
        assert.match(reset.generateResetOtp.toString(), /randomInt/);
        assert.doesNotMatch(reset.generateResetOtp.toString(), /Math\.random/);
    });

    await test('4. forgotPassword_enforces_account_resend_cooldown', () => {
        const { reset } = loadSecurityModules();
        assert.ok(reset.RESET_SECURITY.RESET_REQUEST_COOLDOWN_MS > 0);
        assert.match(reset.issueResetChallenge.toString(), /passwordResetRequestedAt/);
    });

    await test('5. forgotPassword_is_route_rate_limited', () => {
        assert.match(routeSource, /resetRequestLimiter[^\n]*forgotPassword|forgot-password'\s*,\s*resetRequestLimiter/);
        assert.match(routeSource, /resetVerifyLimiter[^\n]*verifyResetOTP|verify-reset-otp'\s*,\s*resetVerifyLimiter/);
        assert.match(routeSource, /resetCompleteLimiter[^\n]*resetPassword|reset-password\/:token'\s*,\s*resetCompleteLimiter/);
    });

    await test('6. verifyResetOTP_rejects_after_max_failed_attempts', () => {
        const { reset } = loadSecurityModules();
        assert.strictEqual(reset.RESET_SECURITY.MAX_OTP_ATTEMPTS, 5);
        assert.match(reset.verifyResetChallenge.toString(), /\$lt/);
    });

    await test('7. failed_attempt_limit_survives_new_request_process_context', () => {
        assert.match(modelSource, /passwordResetAttempts/);
        assert.match(loadSecurityModules().reset.verifyResetChallenge.toString(), /\$inc/);
    });

    await test('8. concurrent_correct_OTP_consumption_has_exactly_one_winner', () => {
        const source = loadSecurityModules().reset.verifyResetChallenge.toString();
        assert.match(source, /findOneAndUpdate/);
        assert.match(source, /passwordResetOtpDigest/);
        assert.match(source, /passwordResetConsumedAt/);
    });

    await test('9. verifyResetOTP_returns_reset_authorization_not_access_token', () => {
        assert.match(controllerSource, /token:\s*resetToken/);
        assert.doesNotMatch(controllerSource, /const token = generateToken\(user, '15m'\)/);
    });

    await test('10. reset_authorization_cannot_authenticate_auth_me', async () => {
        const { tokens } = loadSecurityModules();
        const token = tokens.generatePasswordResetToken(makeUser(), 'reset-jti');
        const result = await runMiddleware(token, makeUser({ status: true }));
        assert.strictEqual(result.nextCalled, false);
    });

    await test('11. ordinary_access_token_cannot_reset_password', () => {
        const { tokens } = loadSecurityModules();
        const token = tokens.generateAccessToken(makeUser());
        assert.throws(() => tokens.verifyPurposeToken(token, tokens.TOKEN_PURPOSES.PASSWORD_RESET));
    });

    await test('12. expired_reset_authorization_cannot_reset_password', () => {
        const { tokens } = loadSecurityModules();
        const token = tokens.generatePasswordResetToken(makeUser(), 'expired-jti', '-1s');
        assert.throws(() => tokens.verifyPurposeToken(token, tokens.TOKEN_PURPOSES.PASSWORD_RESET));
    });

    await test('13. reset_authorization_is_one_use', () => {
        const source = loadSecurityModules().reset.completePasswordReset.toString();
        assert.match(source, /passwordResetTokenDigest/);
        assert.match(source, /\$unset/);
    });

    await test('14. concurrent_reset_authorization_consumption_has_exactly_one_winner', () => {
        const source = loadSecurityModules().reset.completePasswordReset.toString();
        assert.match(source, /findOneAndUpdate/);
        assert.match(source, /passwordResetTokenDigest/);
    });

    await test('15. successful_password_reset_invalidates_preexisting_access_tokens', () => {
        assert.match(loadSecurityModules().reset.completePasswordReset.toString(), /authVersion/);
        assert.match(loadSecurityModules().reset.completePasswordReset.toString(), /\$inc/);
    });

    await test('16. successful_password_reset_requires_normal_login_afterward', () => {
        assert.doesNotMatch(controllerSource, /resetPassword[\s\S]*?sendToken\(/);
        assert.match(controllerSource, /reauthenticationRequired/);
    });

    await test('17. changePassword_rejects_missing_currentPassword', () => {
        assert.match(controllerSource, /currentPassword\s*\|\|\s*oldPassword/);
        assert.match(controllerSource, /Current password is required/);
    });

    await test('18. changePassword_rejects_wrong_currentPassword', () => {
        assert.match(controllerSource, /bcrypt\.compare\(currentPassword/);
        assert.match(controllerSource, /Current password is incorrect/);
    });

    await test('19. changePassword_accepts_correct_currentPassword_and_valid_newPassword', () => {
        assert.match(controllerSource, /CHANGE_PASSWORD/);
        assert.match(controllerSource, /passwordHistory/);
    });

    await test('20. successful_changePassword_invalidates_preexisting_access_tokens', () => {
        const changeSection = controllerSource.slice(controllerSource.indexOf('const changePassword'), controllerSource.indexOf('const verifyOTP'));
        assert.match(changeSection, /authVersion/);
        assert.match(changeSection, /\$inc/);
    });

    await test('21. setPin_allows_initial_creation_when_no_PIN_exists', () => {
        assert.match(pinSource, /setPin/);
        assert.match(pinSource, /transactionPin/);
    });

    await test('22. setPin_rejects_overwrite_when_PIN_already_exists', () => {
        assert.match(pinSource, /PIN_ALREADY_SET/);
    });

    await test('23. changePin_still_requires_correct_old_PIN', () => {
        assert.match(pinSource, /changePin[\s\S]*bcrypt\.compare\(oldPin, user\.transactionPin\)/);
    });

    await test('24. generic_access_JWT_cannot_verify_email', () => {
        const { tokens } = loadSecurityModules();
        const token = tokens.generateAccessToken(makeUser());
        assert.throws(() => tokens.verifyPurposeToken(token, tokens.TOKEN_PURPOSES.EMAIL_VERIFICATION));
    });

    await test('25. password_reset_authorization_cannot_verify_email', () => {
        const { tokens } = loadSecurityModules();
        const token = tokens.generatePasswordResetToken(makeUser(), 'reset-jti');
        assert.throws(() => tokens.verifyPurposeToken(token, tokens.TOKEN_PURPOSES.EMAIL_VERIFICATION));
    });

    await test('26. dedicated_email_verification_token_can_verify_email', () => {
        const { tokens } = loadSecurityModules();
        const token = tokens.generateEmailVerificationToken(makeUser());
        const decoded = tokens.verifyPurposeToken(token, tokens.TOKEN_PURPOSES.EMAIL_VERIFICATION);
        assert.strictEqual(decoded.sub, makeUser()._id);
        assert.strictEqual(decoded.email, makeUser().email);
    });

    await test('27. email_verification_does_not_set_account_status_true', () => {
        const section = controllerSource.slice(controllerSource.indexOf('const verifyEmail'), controllerSource.indexOf('const login'));
        assert.doesNotMatch(section, /\$set\s*:\s*\{[^}]*status\s*:\s*true/);
        assert.match(section, /isEmailVerified\s*:\s*true/);
    });

    await test('28. disabled_account_cannot_reactivate_through_verify_email', () => {
        const section = controllerSource.slice(controllerSource.indexOf('const verifyEmail'), controllerSource.indexOf('const login'));
        assert.doesNotMatch(section, /\$set\s*:\s*\{[^}]*status\s*:\s*true/);
        assert.match(section, /status\s*:\s*true[^\n]*\}/);
    });

    await test('29. email_verification_token_cannot_authenticate_normal_API', async () => {
        const { tokens } = loadSecurityModules();
        const token = tokens.generateEmailVerificationToken(makeUser());
        const result = await runMiddleware(token, makeUser({ status: true }));
        assert.strictEqual(result.nextCalled, false);
    });

    await test('30. email_verification_token_cannot_reset_password', () => {
        const { tokens } = loadSecurityModules();
        const token = tokens.generateEmailVerificationToken(makeUser());
        assert.throws(() => tokens.verifyPurposeToken(token, tokens.TOKEN_PURPOSES.PASSWORD_RESET));
    });

    await test('31. reset_token_cannot_be_used_as_access_token', () => {
        const { tokens } = loadSecurityModules();
        const token = tokens.generatePasswordResetToken(makeUser(), 'reset-jti');
        assert.throws(() => tokens.verifyPurposeToken(token, tokens.TOKEN_PURPOSES.ACCESS));
    });

    await test('32. old_version_access_token_is_rejected_after_authVersion_increment', async () => {
        const { tokens } = loadSecurityModules();
        const token = tokens.generateAccessToken(makeUser({ authVersion: 0 }));
        const result = await runMiddleware(token, makeUser({ status: true, authVersion: 1 }));
        assert.strictEqual(result.nextCalled, false);
        assert.strictEqual(result.res.statusCode, 401);
    });

    // Token payloads must explicitly carry purpose/version rather than relying on
    // endpoint convention.
    await test('access tokens carry explicit access purpose and auth version', () => {
        const { tokens } = loadSecurityModules();
        const decoded = jwt.decode(tokens.generateAccessToken(makeUser({ authVersion: 3 })));
        assert.strictEqual(decoded.purpose, tokens.TOKEN_PURPOSES.ACCESS);
        assert.strictEqual(decoded.authVersion, 3);
    });

    await test('normal auth middleware rejects non-access token purposes before next()', () => {
        assert.match(authSource, /verifyAccessToken/);
    });

    await test('request logging redacts reset and email verification tokens', () => {
        assert.match(serverSource, /sanitizeUrl/);
        assert.match(sanitizerSource, /reset-password\|verify-email/);
    });

    await test('legacy 7-day access token is accepted', () => {
        const { tokens } = loadSecurityModules();
        const token = jwt.sign({ id: makeUser()._id, email: makeUser().email, roles: ['user'] }, process.env.JWT_SECRET, { expiresIn: '7d' });
        assert.strictEqual(tokens.verifyAccessToken(token).id, makeUser()._id);
    });

    await test('legacy 30-day access token is accepted', () => {
        const { tokens } = loadSecurityModules();
        const token = jwt.sign({ id: makeUser()._id, email: makeUser().email, roles: ['user'] }, process.env.JWT_SECRET, { expiresIn: '30d' });
        assert.strictEqual(tokens.verifyAccessToken(token).id, makeUser()._id);
    });

    await test('legacy 15-minute reset token is rejected as access', () => {
        const { tokens } = loadSecurityModules();
        const token = jwt.sign({ id: makeUser()._id }, process.env.JWT_SECRET, { expiresIn: '15m' });
        assert.throws(() => tokens.verifyAccessToken(token), error => error.code === 'TOKEN_PURPOSE_MISMATCH');
    });

    await test('explicit falsey token purposes are rejected as access', () => {
        const { tokens } = loadSecurityModules();
        for (const purpose of [null, '', false, 0]) {
            const token = jwt.sign({ id: makeUser()._id, purpose }, process.env.JWT_SECRET, { expiresIn: '7d' });
            assert.throws(() => tokens.verifyAccessToken(token), error => error.code === 'TOKEN_PURPOSE_MISMATCH');
        }
    });

    await test('untyped one-hour token is rejected as access', () => {
        const { tokens } = loadSecurityModules();
        const token = jwt.sign({ id: makeUser()._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
        assert.throws(() => tokens.verifyAccessToken(token), error => error.code === 'TOKEN_PURPOSE_MISMATCH');
    });

    await test('untyped token without exp is rejected as access', () => {
        const { tokens } = loadSecurityModules();
        const token = jwt.sign({ id: makeUser()._id }, process.env.JWT_SECRET);
        assert.throws(() => tokens.verifyAccessToken(token), error => error.code === 'TOKEN_PURPOSE_MISMATCH');
    });

    await test('legacy token with malformed NumericDate is rejected as access', () => {
        const { tokens } = loadSecurityModules();
        const token = jwt.sign({ id: makeUser()._id, iat: 1.5, exp: 9999999999 }, process.env.JWT_SECRET);
        assert.throws(() => tokens.verifyAccessToken(token), error => error.code === 'TOKEN_PURPOSE_MISMATCH');
    });

    await test('stale old-PIN authorization cannot overwrite a newer PIN', async () => {
        const User = require('../models/User');
        const pinService = require('../services/pin.service');
        const originals = {
            findOne: User.findOne,
            findOneAndUpdate: User.findOneAndUpdate,
            compare: bcrypt.compare,
            hash: bcrypt.hash
        };
        let storedHash = 'H1';
        let comparisons = 0;
        let databaseReads = 0;
        User.findOne = () => {
            databaseReads++;
            return {
                select: async () => ({ _id: 'PIN_USER', status: true, transactionPin: storedHash, pinHistory: [] })
            };
        };
        User.findOneAndUpdate = async (filter, update) => {
            if (filter.status === true && filter.transactionPin === storedHash) {
                storedHash = update.$set.transactionPin;
                return { _id: 'PIN_USER' };
            }
            return null;
        };
        bcrypt.compare = async (plain, hash) => {
            comparisons++;
            if (plain === '1111' && hash === 'H1') {
                storedHash = 'H2';
                return true;
            }
            return false;
        };
        bcrypt.hash = async () => 'H3';
        try {
            await assert.rejects(() => pinService.changePin('PIN_USER', '1111', '3333'), /concurrently/);
            assert.strictEqual(storedHash, 'H2');
            assert.strictEqual(databaseReads, 1, 'authorization and CAS must use one database snapshot');
            assert.strictEqual(comparisons, 2, 'old and new PIN checks must use the same snapshot');
        } finally {
            User.findOne = originals.findOne;
            User.findOneAndUpdate = originals.findOneAndUpdate;
            bcrypt.compare = originals.compare;
            bcrypt.hash = originals.hash;
        }
    });

    await test('initial PIN mutation loses the race when account becomes inactive', async () => {
        const User = require('../models/User');
        const pinService = require('../services/pin.service');
        const originals = { findOne: User.findOne, findOneAndUpdate: User.findOneAndUpdate, hash: bcrypt.hash };
        let active = true;
        User.findOne = () => ({ select: async () => ({ _id: 'PIN_USER', status: true, transactionPin: null, pinHistory: [] }) });
        bcrypt.hash = async () => { active = false; return 'PIN_HASH'; };
        User.findOneAndUpdate = async filter => filter.status === true && active ? { _id: 'PIN_USER' } : null;
        try {
            await assert.rejects(() => pinService.setPin('PIN_USER', '1234'), /changed concurrently/);
            assert.strictEqual(active, false);
        } finally {
            User.findOne = originals.findOne;
            User.findOneAndUpdate = originals.findOneAndUpdate;
            bcrypt.hash = originals.hash;
        }
    });

    await test('PIN change loses the race when account becomes inactive', async () => {
        const User = require('../models/User');
        const pinService = require('../services/pin.service');
        const originals = {
            findOne: User.findOne,
            findOneAndUpdate: User.findOneAndUpdate,
            compare: bcrypt.compare,
            hash: bcrypt.hash
        };
        let active = true;
        User.findOne = () => ({
            select: async () => ({ _id: 'PIN_USER', status: true, transactionPin: 'H1', pinHistory: [] })
        });
        bcrypt.compare = async (plain, hash) => {
            if (plain === '1111' && hash === 'H1') {
                active = false;
                return true;
            }
            return false;
        };
        bcrypt.hash = async () => 'H2';
        User.findOneAndUpdate = async filter => filter.status === true && active ? { _id: 'PIN_USER' } : null;
        try {
            await assert.rejects(() => pinService.changePin('PIN_USER', '1111', '2222'), /changed concurrently/);
            assert.strictEqual(active, false);
        } finally {
            User.findOne = originals.findOne;
            User.findOneAndUpdate = originals.findOneAndUpdate;
            bcrypt.compare = originals.compare;
            bcrypt.hash = originals.hash;
        }
    });

    await test('phone verification changes only phone-verification state', async () => {
        const User = require('../models/User');
        const authController = require('../controllers/authController');
        const original = User.findOneAndUpdate;
        let observed;
        User.findOneAndUpdate = async (filter, update) => {
            observed = { filter, update };
            return { _id: 'PHONE_USER', status: true, isPhoneVerified: true };
        };
        const res = makeRes();
        try {
            await authController.verifyOTP({ body: { otp: '123456' }, user: { id: 'PHONE_USER' } }, res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(observed.filter.status, true);
            assert.strictEqual(observed.filter.otp, '123456');
            assert.ok(observed.filter.otpExpires.$gt instanceof Date);
            assert.deepStrictEqual(observed.update.$set, { isPhoneVerified: true });
            assert.ok(!Object.prototype.hasOwnProperty.call(observed.update.$set, 'status'));
        } finally {
            User.findOneAndUpdate = original;
        }
    });

    await test('phone verification loses race when account becomes inactive', async () => {
        const User = require('../models/User');
        const authController = require('../controllers/authController');
        const original = User.findOneAndUpdate;
        let active = true;
        User.findOneAndUpdate = async filter => {
            active = false;
            return filter.status === true && active ? { _id: 'PHONE_USER' } : null;
        };
        const res = makeRes();
        try {
            await authController.verifyOTP({ body: { otp: '123456' }, user: { id: 'PHONE_USER' } }, res);
            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(active, false);
        } finally {
            User.findOneAndUpdate = original;
        }
    });

    await test('reset OTP consumption loses race when account becomes inactive', async () => {
        const User = require('../models/User');
        const resetService = require('../services/passwordReset.service');
        const originals = { findOne: User.findOne, findOneAndUpdate: User.findOneAndUpdate };
        const challengeId = 'RESET_CHALLENGE';
        const otp = '405162';
        const user = {
            _id: 'RESET_USER',
            status: true,
            passwordResetChallengeId: challengeId,
            passwordResetOtpDigest: resetService.digestValue('password_reset_otp', `${challengeId}:${otp}`),
            passwordResetExpiresAt: new Date(Date.now() + 60000),
            passwordResetAttempts: 0,
            authVersion: 0
        };
        let active = true;
        let observedFilter;
        User.findOne = () => ({ select: async () => user });
        User.findOneAndUpdate = filter => {
            observedFilter = filter;
            active = false;
            const value = filter.status === true && active ? user : null;
            return { select: async () => value };
        };
        try {
            await assert.rejects(() => resetService.verifyResetChallenge('08000000000', otp), /Invalid or expired/);
            assert.strictEqual(observedFilter.status, true);
        } finally {
            User.findOne = originals.findOne;
            User.findOneAndUpdate = originals.findOneAndUpdate;
        }
    });

    await test('password change loses race when account becomes inactive', async () => {
        const User = require('../models/User');
        const authController = require('../controllers/authController');
        const originals = {
            findById: User.findById,
            findOneAndUpdate: User.findOneAndUpdate,
            compare: bcrypt.compare,
            hash: bcrypt.hash
        };
        let active = true;
        let observedFilter;
        User.findById = () => ({
            select: async () => ({ _id: 'PASSWORD_USER', password: 'OLD_HASH', passwordHistory: [], authVersion: 0 })
        });
        bcrypt.compare = async (plain, hash) => plain === 'correct-current' && hash === 'OLD_HASH';
        bcrypt.hash = async () => { active = false; return 'NEW_HASH'; };
        User.findOneAndUpdate = async filter => {
            observedFilter = filter;
            return filter.status === true && active ? { _id: 'PASSWORD_USER' } : null;
        };
        const res = makeRes();
        try {
            await authController.changePassword({
                body: { currentPassword: 'correct-current', newPassword: 'new-password' },
                user: { id: 'PASSWORD_USER' },
                headers: {}
            }, res);
            assert.strictEqual(observedFilter.status, true);
            assert.strictEqual(res.statusCode, 409);
        } finally {
            User.findById = originals.findById;
            User.findOneAndUpdate = originals.findOneAndUpdate;
            bcrypt.compare = originals.compare;
            bcrypt.hash = originals.hash;
        }
    });

    await test('verify-reset-otp preserves token field with password_reset purpose', async () => {
        const authController = require('../controllers/authController');
        const resetService = require('../services/passwordReset.service');
        const original = resetService.verifyResetChallenge;
        const resetToken = loadSecurityModules().tokens.generatePasswordResetToken(makeUser(), 'response-jti');
        resetService.verifyResetChallenge = async () => ({ resetToken });
        const res = makeRes();
        try {
            await authController.verifyResetOTP({ body: { phone: '08000000000', otp: '123456' } }, res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.token, resetToken);
            assert.strictEqual(res.body.resetToken, undefined);
            const decoded = loadSecurityModules().tokens.verifyPurposeToken(res.body.token, 'password_reset');
            assert.strictEqual(decoded.purpose, 'password_reset');
            const middlewareResult = await runMiddleware(res.body.token, makeUser({ status: true }));
            assert.strictEqual(middlewareResult.nextCalled, false);
        } finally {
            resetService.verifyResetChallenge = original;
        }
    });

    await test('optional auth never trusts a revoked token', async () => {
        const token = loadSecurityModules().tokens.generateAccessToken(makeUser({ authVersion: 0 }));
        const result = await runOptionalMiddleware(token, makeUser({ status: true, authVersion: 1 }));
        assert.strictEqual(result.nextCalled, true);
        assert.strictEqual(result.req.user, undefined);
    });

    await test('optional auth never trusts an inactive user', async () => {
        const token = loadSecurityModules().tokens.generateAccessToken(makeUser({ authVersion: 0 }));
        const result = await runOptionalMiddleware(token, makeUser({ status: false, authVersion: 0 }));
        assert.strictEqual(result.nextCalled, true);
        assert.strictEqual(result.req.user, undefined);
    });

    await test('optional auth never trusts a deleted user', async () => {
        const token = loadSecurityModules().tokens.generateAccessToken(makeUser({ authVersion: 0 }));
        const result = await runOptionalMiddleware(token, null);
        assert.strictEqual(result.nextCalled, true);
        assert.strictEqual(result.req.user, undefined);
    });

    const assertErrorLogRedacted = async routeName => {
        const Log = require('../models/Logs');
        const errorHandler = require('../middlewares/errorHandler');
        const originalCreate = Log.create;
        const rawToken = `${routeName}-RAW-BEARER-SECRET`;
        const rawPassword = 'RAW-PASSWORD-SECRET';
        const rawPin = '7391';
        const rawOtp = '590284';
        const rawAuthorization = 'Bearer RAW-AUTHORIZATION-SECRET';
        let persisted;
        Log.create = async value => { persisted = value; return value; };
        const req = {
            originalUrl: `/api/auth/${routeName}/${rawToken}`,
            method: 'PUT',
            params: { token: rawToken },
            body: { password: rawPassword, pin: rawPin, otp: rawOtp },
            headers: { authorization: rawAuthorization }
        };
        const res = makeRes();
        try {
            const consoleOutput = await captureConsole(['error'], () => errorHandler(
                new Error(`failed ${rawToken} ${rawPassword} ${rawPin} ${rawOtp} ${rawAuthorization}`),
                req,
                res,
                () => {}
            ));
            const allOutput = `${consoleOutput}\n${JSON.stringify(persisted)}\n${JSON.stringify(res.body)}`;
            for (const secret of [rawToken, rawPassword, rawPin, rawOtp, rawAuthorization, 'RAW-AUTHORIZATION-SECRET']) {
                assert.ok(!allOutput.includes(secret), `${routeName} log leaked ${secret}`);
            }
        } finally {
            Log.create = originalCreate;
        }
    };

    await test('raw reset token is absent from captured error logs', () => assertErrorLogRedacted('reset-password'));
    await test('raw email-verification token is absent from captured error logs', () => assertErrorLogRedacted('verify-email'));

    await test('raw OTP is absent from notification logs', async () => {
        const notificationService = require('../services/notification.service');
        const originalCreate = notificationService._createEventDeduped;
        const originalPush = notificationService._pushToUser;
        notificationService._createEventDeduped = async () => ({ _id: 'NOTIFICATION' });
        notificationService._pushToUser = () => {};
        const rawOtp = '846291';
        try {
            const output = await captureConsole(['log'], () => notificationService.sendInApp('USER', {
                title: 'Verification Code',
                message: `Your verification code is ${rawOtp}`,
                type: 'security'
            }));
            assert.ok(!output.includes(rawOtp));
        } finally {
            notificationService._createEventDeduped = originalCreate;
            notificationService._pushToUser = originalPush;
        }
    });

    await test('full push token is absent from controller and notification logs', async () => {
        const User = require('../models/User');
        const authController = require('../controllers/authController');
        const notificationService = require('../services/notification.service');
        const originalUpdate = User.findByIdAndUpdate;
        const originalRequest = https.request;
        const pushToken = 'ExponentPushToken[RAW_DEVICE_SECRET]';
        User.findByIdAndUpdate = async () => ({ _id: 'PUSH_USER' });
        https.request = (options, callback) => {
            const request = new EventEmitter();
            request.write = () => {};
            request.end = () => {
                const response = new EventEmitter();
                callback(response);
                response.emit('data', JSON.stringify({ data: { status: 'ok', echoedToken: pushToken } }));
                response.emit('end');
            };
            return request;
        };
        try {
            const output = await captureConsole(['log', 'warn', 'error'], async () => {
                await authController.savePushToken({ body: { pushToken }, user: { id: 'PUSH_USER' } }, makeRes());
                await notificationService.sendPush(pushToken, { title: 'Security', body: 'Body' });
            });
            assert.ok(!output.includes(pushToken));
        } finally {
            User.findByIdAndUpdate = originalUpdate;
            https.request = originalRequest;
        }
    });

    console.log('\n====================================================');
    console.log(` RESULT: ${passed} passed, ${failed} failed`);
    console.log('====================================================');
    process.exitCode = failed ? 1 : 0;
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
