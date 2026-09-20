'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'h8-jwt-secret';
process.env.PHONE_OTP_SECRET = process.env.PHONE_OTP_SECRET || 'h8-phone-otp-secret';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const phoneVerificationService = require('../services/phoneVerification.service');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

let passed = 0;
let failed = 0;

async function test(name, operation) {
    try {
        await operation();
        console.log(`  [PASS] ${name}`);
        passed++;
    } catch (error) {
        console.error(`  [FAIL] ${name}`);
        console.error(`         ${error.message}`);
        failed++;
    }
}

function makeRes() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; if (this.statusCode === null) this.statusCode = 200; return this; },
        cookie() { return this; }
    };
}

function selected(value) {
    return { select: async () => value };
}

function challengeUser(overrides = {}) {
    const user = {
        _id: 'PHONE_USER',
        phone: '08012345678',
        status: true,
        phoneVerificationChallengeId: 'CHALLENGE_1',
        phoneVerificationPhone: '08012345678',
        phoneVerificationExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
        phoneVerificationAttempts: 0,
        ...overrides
    };
    const otp = overrides.otp || '405162';
    user.phoneVerificationOtpDigest = overrides.phoneVerificationOtpDigest ||
        phoneVerificationService.digestPhoneOtp(user._id, user.phoneVerificationChallengeId, user.phoneVerificationPhone, otp);
    delete user.otp;
    return { user, otp };
}

async function withUserMethods(methods, operation) {
    const originals = {};
    for (const [name, replacement] of Object.entries(methods)) {
        originals[name] = User[name];
        User[name] = replacement;
    }
    try {
        return await operation();
    } finally {
        for (const [name, original] of Object.entries(originals)) User[name] = original;
    }
}

async function main() {
    console.log('====================================================');
    console.log(' H8 PHONE VERIFICATION TESTS');
    console.log('====================================================\n');

    const controllerSource = read('controllers/authController.js');
    const serviceSource = read('services/phoneVerification.service.js');
    const routeSource = read('routes/auth.js');

    await test('A-B. registration starts false and does not accept client verification state', () => {
        const registration = controllerSource.slice(
            controllerSource.indexOf('const register'),
            controllerSource.indexOf('const verifyEmail')
        );
        assert.match(registration, /isPhoneVerified:\s*false/);
        assert.doesNotMatch(registration, /let\s*\{[^}]*isPhoneVerified[^}]*\}\s*=\s*req\.body/);
    });

    await test('C. login preserves an unverified backend user', async () => {
        const authController = require('../controllers/authController');
        const originalCompare = bcrypt.compare;
        const originalActivityCreate = ActivityLog.create;
        const user = {
            _id: 'LOGIN_USER',
            name: 'User',
            phone: '08012345678',
            email: 'user@example.com',
            password: 'HASH',
            role: 'user',
            roles: ['user'],
            status: true,
            isPhoneVerified: false,
            isPinSet: false,
            save: async () => {}
        };
        try {
            bcrypt.compare = async () => true;
            ActivityLog.create = async () => ({});
            await withUserMethods({ findOne: () => selected(user) }, async () => {
                const res = makeRes();
                await authController.login({
                    body: { phone: user.phone, password: 'Password1!' },
                    ip: '127.0.0.1',
                    headers: { 'user-agent': 'test' }
                }, res);
                assert.strictEqual(res.statusCode, 200);
                assert.strictEqual(res.body.user.isPhoneVerified, false);
            });
        } finally {
            bcrypt.compare = originalCompare;
            ActivityLog.create = originalActivityCreate;
        }
    });

    await test('D-F. phone edits reset only on actual change and ignore client verification flags', async () => {
        const authController = require('../controllers/authController');
        const originalActivityCreate = ActivityLog.create;
        ActivityLog.create = async () => ({});
        try {
            const runUpdate = async (current, body) => {
                let observed;
                return withUserMethods({
                    findById: () => selected(current),
                    findOneAndUpdate: async (filter, update) => {
                        observed = { filter, update };
                        return { ...current, ...(update.$set || update) };
                    }
                }, async () => {
                    const res = makeRes();
                    await authController.updateUser({
                        user: { id: current._id },
                        params: { id: current._id },
                        body,
                        ip: '127.0.0.1',
                        headers: { 'user-agent': 'test' }
                    }, res);
                    return { observed, res };
                });
            };

            const base = {
                _id: 'PROFILE_USER',
                name: 'User',
                email: 'user@example.com',
                phone: '08012345678',
                role: 'user',
                roles: ['user'],
                isPhoneVerified: true,
                isPinSet: false
            };
            const changed = await runUpdate(base, { phone: '08099999999' });
            assert.strictEqual(changed.observed.update.$set.isPhoneVerified, false);
            assert.strictEqual(changed.res.body.user.isPhoneVerified, false);
            assert.ok(changed.observed.update.$unset.phoneVerificationOtpDigest);

            const unchanged = await runUpdate(base, { phone: '08012345678' });
            assert.strictEqual(unchanged.observed.update.isPhoneVerified, undefined);
            assert.strictEqual(unchanged.observed.filter.phone, base.phone);
            assert.strictEqual(unchanged.res.body.user.isPhoneVerified, true);

            const unverified = { ...base, isPhoneVerified: false };
            const injected = await runUpdate(unverified, { isPhoneVerified: true, name: 'Still User' });
            assert.strictEqual(injected.observed.update.isPhoneVerified, undefined);
            assert.strictEqual(injected.res.body.user.isPhoneVerified, false);
        } finally {
            ActivityLog.create = originalActivityCreate;
        }
    });

    await test('G-H. issuance uses CSPRNG, HMAC digest, current phone binding and bounded TTL', async () => {
        assert.match(serviceSource, /crypto\.randomInt/);
        assert.doesNotMatch(serviceSource, /Math\.random/);
        const current = { _id: 'ISSUE_USER', phone: '08012345678', status: true };
        let observed;
        await withUserMethods({
            findOne: () => selected(current),
            findOneAndUpdate: (filter, update) => {
                observed = { filter, update };
                return selected({ ...current });
            }
        }, async () => {
            const before = Date.now();
            const challenge = await phoneVerificationService.issuePhoneVerificationChallenge(current._id);
            const after = Date.now();
            const fields = observed.update.$set;
            assert.strictEqual(observed.filter.phone, current.phone);
            assert.strictEqual(fields.phoneVerificationPhone, current.phone);
            assert.notStrictEqual(fields.phoneVerificationOtpDigest, challenge.otp);
            assert.strictEqual(Object.prototype.hasOwnProperty.call(fields, 'otp'), false);
            assert.strictEqual(fields.phoneVerificationOtpDigest,
                phoneVerificationService.digestPhoneOtp(current._id, challenge.challengeId, current.phone, challenge.otp));
            assert.ok(fields.phoneVerificationExpiresAt.getTime() >= before + 10 * 60 * 1000);
            assert.ok(fields.phoneVerificationExpiresAt.getTime() <= after + 10 * 60 * 1000);
        });
    });

    await test('I. invalid codes do not verify and atomically increment attempts', async () => {
        const { user } = challengeUser();
        let observed;
        await withUserMethods({
            findOne: () => selected(user),
            findOneAndUpdate: async (filter, update) => { observed = { filter, update }; return user; }
        }, async () => {
            await assert.rejects(
                () => phoneVerificationService.verifyPhoneVerificationChallenge(user._id, '000000'),
                /Invalid or expired/
            );
            assert.strictEqual(observed.filter.status, true);
            assert.strictEqual(observed.filter.phone, user.phone);
            assert.deepStrictEqual(observed.update, { $inc: { phoneVerificationAttempts: 1 } });
        });
    });

    await test('J. expired challenges cannot verify', async () => {
        const { user, otp } = challengeUser({ phoneVerificationExpiresAt: new Date(Date.now() - 1) });
        let writes = 0;
        await withUserMethods({
            findOne: () => selected(user),
            findOneAndUpdate: async () => { writes++; return user; }
        }, async () => {
            await assert.rejects(
                () => phoneVerificationService.verifyPhoneVerificationChallenge(user._id, otp),
                /Invalid or expired/
            );
            assert.strictEqual(writes, 0);
        });
    });

    await test('K. current-phone binding rejects A after A-to-B and accepts a B challenge', async () => {
        const old = challengeUser({ phone: '08022222222', phoneVerificationPhone: '08011111111' });
        await withUserMethods({ findOne: () => selected(old.user) }, async () => {
            await assert.rejects(
                () => phoneVerificationService.verifyPhoneVerificationChallenge(old.user._id, old.otp),
                /Invalid or expired/
            );
        });

        const current = challengeUser({
            phone: '08022222222',
            phoneVerificationPhone: '08022222222',
            phoneVerificationChallengeId: 'CHALLENGE_B'
        });
        await withUserMethods({
            findOne: () => selected(current.user),
            findOneAndUpdate: async () => ({ ...current.user, isPhoneVerified: true })
        }, async () => {
            const verified = await phoneVerificationService.verifyPhoneVerificationChallenge(current.user._id, current.otp);
            assert.strictEqual(verified.isPhoneVerified, true);
        });
    });

    await test('L. a valid challenge is atomically single-use under concurrent verification', async () => {
        const { user, otp } = challengeUser();
        let consumed = false;
        let observedUpdate;
        await withUserMethods({
            findOne: () => selected(user),
            findOneAndUpdate: async (filter, update) => {
                if (!update.$set?.isPhoneVerified) return user;
                observedUpdate = { filter, update };
                if (consumed) return null;
                consumed = true;
                return { ...user, isPhoneVerified: true };
            }
        }, async () => {
            const results = await Promise.allSettled([
                phoneVerificationService.verifyPhoneVerificationChallenge(user._id, otp),
                phoneVerificationService.verifyPhoneVerificationChallenge(user._id, otp)
            ]);
            assert.strictEqual(results.filter(result => result.status === 'fulfilled').length, 1);
            assert.strictEqual(results.filter(result => result.status === 'rejected').length, 1);
            assert.strictEqual(observedUpdate.filter.status, true);
            assert.strictEqual(observedUpdate.filter.phone, user.phone);
            assert.deepStrictEqual(observedUpdate.update.$set, { isPhoneVerified: true });
            assert.ok(observedUpdate.update.$unset.phoneVerificationOtpDigest);
        });
    });

    await test('M. new issuance replaces the previous challenge and invalidates its OTP', async () => {
        const current = {
            _id: 'REISSUE_USER',
            phone: '08012345678',
            status: true,
            phoneVerificationRequestedAt: new Date(Date.now() - 2 * 60 * 1000)
        };
        const issuedFields = [];
        await withUserMethods({
            findOne: () => selected(current),
            findOneAndUpdate: (_filter, update) => {
                issuedFields.push(update.$set);
                return selected(current);
            }
        }, async () => {
            const first = await phoneVerificationService.issuePhoneVerificationChallenge(current._id);
            const second = await phoneVerificationService.issuePhoneVerificationChallenge(current._id);
            assert.notStrictEqual(first.challengeId, second.challengeId);
            assert.notStrictEqual(issuedFields[0].phoneVerificationOtpDigest, issuedFields[1].phoneVerificationOtpDigest);
            assert.notStrictEqual(
                phoneVerificationService.digestPhoneOtp(current._id, second.challengeId, current.phone, first.otp),
                issuedFields[1].phoneVerificationOtpDigest
            );
        });
    });

    await test('N. account cooldown and route/IP throttles bound issue and verify requests', async () => {
        const current = {
            _id: 'COOLDOWN_USER',
            phone: '08012345678',
            status: true,
            phoneVerificationRequestedAt: new Date()
        };
        let writes = 0;
        await withUserMethods({
            findOne: () => selected(current),
            findOneAndUpdate: () => { writes++; return selected(current); }
        }, async () => {
            await assert.rejects(
                () => phoneVerificationService.issuePhoneVerificationChallenge(current._id),
                error => error.statusCode === 429 && error.code === 'PHONE_OTP_COOLDOWN'
            );
            assert.strictEqual(writes, 0);
        });
        assert.match(routeSource, /send-otp',\s*verifyJWT,\s*phoneOtpRequestLimiter/);
        assert.match(routeSource, /verify-otp',\s*verifyJWT,\s*phoneOtpVerifyLimiter/);
    });

    await test('O. failed-attempt limit prevents verification after five failures', async () => {
        const { user } = challengeUser({ phoneVerificationAttempts: 4 });
        let increments = 0;
        await withUserMethods({
            findOne: () => selected(user),
            findOneAndUpdate: async (_filter, update) => {
                if (update.$inc) {
                    increments++;
                    user.phoneVerificationAttempts++;
                }
                return user;
            }
        }, async () => {
            await assert.rejects(() => phoneVerificationService.verifyPhoneVerificationChallenge(user._id, '000000'));
            await assert.rejects(() => phoneVerificationService.verifyPhoneVerificationChallenge(user._id, '405162'));
            assert.strictEqual(increments, 1);
            assert.strictEqual(user.phoneVerificationAttempts, phoneVerificationService.PHONE_VERIFICATION_SECURITY.MAX_OTP_ATTEMPTS);
        });
    });

    await test('P. inactive users cannot issue or consume phone challenges', async () => {
        let writes = 0;
        await withUserMethods({
            findOne: () => selected(null),
            findOneAndUpdate: () => { writes++; return selected(null); }
        }, async () => {
            await assert.rejects(() => phoneVerificationService.issuePhoneVerificationChallenge('INACTIVE'));
            await assert.rejects(() => phoneVerificationService.verifyPhoneVerificationChallenge('INACTIVE', '405162'));
            assert.strictEqual(writes, 0);
        });
    });

    await test('Q. API response/logs hide OTP and undelivered SMS invalidates the challenge', async () => {
        const sms = require('../utils/sms');
        const originalSendSms = sms.sendSMS;
        const originalIssue = phoneVerificationService.issuePhoneVerificationChallenge;
        const originalInvalidate = phoneVerificationService.invalidatePhoneVerificationChallenge;
        const otp = '739104';
        let smsMessage;
        let invalidations = 0;
        sms.sendSMS = async (_phone, message) => { smsMessage = message; return { success: true }; };
        phoneVerificationService.issuePhoneVerificationChallenge = async () => ({
            user: { _id: 'PHONE_USER', phone: '08012345678' },
            otp,
            challengeId: 'CHALLENGE'
        });
        phoneVerificationService.invalidatePhoneVerificationChallenge = async () => { invalidations++; };
        delete require.cache[require.resolve('../controllers/authController')];
        const authController = require('../controllers/authController');
        const capturedLogs = [];
        const originalLog = console.log;
        const originalError = console.error;
        console.log = (...args) => capturedLogs.push(args.join(' '));
        console.error = (...args) => capturedLogs.push(args.join(' '));
        try {
            const res = makeRes();
            await authController.sendOTP({ user: { id: 'PHONE_USER' }, body: {} }, res);
            assert.strictEqual(res.statusCode, 200);
            assert.doesNotMatch(JSON.stringify(res.body), new RegExp(otp));
            assert.doesNotMatch(capturedLogs.join('\n'), new RegExp(otp));
            assert.match(smsMessage, new RegExp(otp));

            sms.sendSMS = async () => ({ success: true, delivered: false });
            delete require.cache[require.resolve('../controllers/authController')];
            const undeliveredController = require('../controllers/authController');
            const undeliveredRes = makeRes();
            await undeliveredController.sendOTP({ user: { id: 'PHONE_USER' }, body: {} }, undeliveredRes);
            assert.strictEqual(undeliveredRes.statusCode, 502);
            assert.strictEqual(invalidations, 1);
            assert.doesNotMatch(JSON.stringify(undeliveredRes.body), new RegExp(otp));
        } finally {
            console.log = originalLog;
            console.error = originalError;
            sms.sendSMS = originalSendSms;
            phoneVerificationService.issuePhoneVerificationChallenge = originalIssue;
            phoneVerificationService.invalidatePhoneVerificationChallenge = originalInvalidate;
            delete require.cache[require.resolve('../controllers/authController')];
        }
    });

    await test('R. phone proof is delivered only to the bound phone, not email or in-app', () => {
        const section = controllerSource.slice(
            controllerSource.indexOf('const sendOTP'),
            controllerSource.indexOf('const changePassword')
        );
        assert.match(section, /sendSMS\(/);
        assert.doesNotMatch(section, /sendEmail\(/);
        assert.doesNotMatch(section, /sendInApp\(/);
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
