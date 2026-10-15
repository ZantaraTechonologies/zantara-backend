'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'email-verification-test-secret';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const User = require('../models/User');
const emailVerificationService = require('../services/emailVerification.service');
const { normalizeTermiiPhone, sendSMS } = require('../utils/sms');

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

function selected(value) {
    return { select: async () => value };
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

function activeEmailChallenge(overrides = {}) {
    const otp = overrides.testOtp || '405162';
    const challenge = {
        _id: 'EMAIL_USER',
        name: 'Email User',
        email: 'user@example.test',
        phone: '08146149773',
        status: true,
        emailVerificationChallengeId: 'EMAIL_CHALLENGE',
        emailVerificationEmail: 'user@example.test',
        emailVerificationExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
        emailVerificationAttempts: 0,
        ...overrides
    };
    delete challenge.testOtp;
    challenge.emailVerificationOtpDigest = overrides.emailVerificationOtpDigest ||
        emailVerificationService.digestEmailOtp(challenge._id, challenge.emailVerificationChallengeId, challenge.emailVerificationEmail, otp);
    Object.defineProperty(challenge, 'testOtp', { value: otp });
    return challenge;
}

async function main() {
    console.log('====================================================');
    console.log(' SMS PRE-LAUNCH BLOCKER TESTS');
    console.log('====================================================\n');

    await test('Termii normalizes local Nigerian format', () => {
        assert.strictEqual(normalizeTermiiPhone('08146149773'), '2348146149773');
    });

    await test('Termii normalizes +234 Nigerian format', () => {
        assert.strictEqual(normalizeTermiiPhone('+2348146149773'), '2348146149773');
    });

    await test('Termii preserves canonical 234 Nigerian format', () => {
        assert.strictEqual(normalizeTermiiPhone('2348146149773'), '2348146149773');
    });

    await test('all supported representations produce the same Termii payload destination', async () => {
        const axios = require('axios');
        const originalPost = axios.post;
        const previousKey = process.env.TERMII_API_KEY;
        const destinations = [];
        process.env.TERMII_API_KEY = 'test-only-key';
        axios.post = async (_url, payload) => {
            destinations.push(payload.to);
            return { status: 200, data: { message_id: 'TEST_ONLY' } };
        };
        try {
            for (const phone of ['08146149773', '+2348146149773', '2348146149773']) {
                const result = await sendSMS(phone, 'Test message');
                assert.strictEqual(result.success, true);
            }
            assert.deepStrictEqual(destinations, [
                '2348146149773',
                '2348146149773',
                '2348146149773'
            ]);
        } finally {
            axios.post = originalPost;
            if (previousKey === undefined) delete process.env.TERMII_API_KEY;
            else process.env.TERMII_API_KEY = previousKey;
        }
    });

    await test('malformed destinations fail safely before provider delivery', async () => {
        assert.throws(() => normalizeTermiiPhone('not-a-phone'), /Unsupported Nigerian phone number format/);
        const previousKey = process.env.TERMII_API_KEY;
        process.env.TERMII_API_KEY = 'mock';
        try {
            const result = await sendSMS('not-a-phone', 'Test message');
            assert.strictEqual(result.success, false);
            assert.match(String(result.error), /Unsupported Nigerian phone number format/);
        } finally {
            if (previousKey === undefined) delete process.env.TERMII_API_KEY;
            else process.env.TERMII_API_KEY = previousKey;
        }
    });

    await test('email OTP request creates a bounded server-side challenge', async () => {
        const user = {
            _id: 'EMAIL_USER',
            name: 'Email User',
            email: 'user@example.test',
            phone: '08146149773',
            status: true
        };
        let observed;
        await withUserMethods({
            findOne: () => selected(user),
            findOneAndUpdate: (filter, update) => {
                observed = { filter, update };
                return selected(user);
            }
        }, async () => {
            const before = Date.now();
            const challenge = await emailVerificationService.issueEmailVerificationChallenge(user._id);
            const after = Date.now();
            assert.match(challenge.otp, /^\d{6}$/);
            assert.strictEqual(observed.filter.email, user.email);
            assert.strictEqual(Object.prototype.hasOwnProperty.call(observed.update.$set, 'emailOtp'), false);
            assert.strictEqual(observed.update.$set.emailVerificationEmail, user.email);
            assert.strictEqual(observed.update.$set.emailVerificationAttempts, 0);
            assert.notStrictEqual(observed.update.$set.emailVerificationOtpDigest, challenge.otp);
            assert.strictEqual(
                observed.update.$set.emailVerificationOtpDigest,
                emailVerificationService.digestEmailOtp(user._id, challenge.challengeId, user.email, challenge.otp)
            );
            assert.ok(observed.update.$set.emailVerificationExpiresAt.getTime() >= before + 10 * 60 * 1000);
            assert.ok(observed.update.$set.emailVerificationExpiresAt.getTime() <= after + 10 * 60 * 1000);
            for (const field of ['emailOtp', 'emailOtpEmail', 'emailOtpExpires', 'emailOtpAttempts', 'emailOtpRequestedAt']) {
                assert.strictEqual(observed.update.$unset[field], 1);
            }
        });
    });

    await test('email challenge schema fields are optional and hidden by default', () => {
        for (const field of [
            'emailVerificationChallengeId',
            'emailVerificationOtpDigest',
            'emailVerificationEmail',
            'emailVerificationExpiresAt',
            'emailVerificationAttempts',
            'emailVerificationRequestedAt'
        ]) {
            const options = User.schema.path(field)?.options;
            assert.ok(options, `${field} is missing from the user schema`);
            assert.strictEqual(options.required, undefined);
            assert.strictEqual(options.select, false);
        }
    });

    await test('repeated email OTP requests are blocked during account cooldown', async () => {
        const user = activeEmailChallenge({ emailVerificationRequestedAt: new Date() });
        let writes = 0;
        await withUserMethods({
            findOne: () => selected(user),
            findOneAndUpdate: () => { writes++; return selected(user); }
        }, async () => {
            await assert.rejects(
                () => emailVerificationService.issueEmailVerificationChallenge(user._id),
                error => error.statusCode === 429 && error.code === 'EMAIL_OTP_COOLDOWN'
            );
            assert.strictEqual(writes, 0);
        });
    });

    await test('wrong email OTP increments the persisted failed-attempt count', async () => {
        const user = activeEmailChallenge();
        let observed;
        await withUserMethods({
            findOne: () => selected(user),
            findOneAndUpdate: async (filter, update) => { observed = { filter, update }; return user; }
        }, async () => {
            await assert.rejects(
                () => emailVerificationService.verifyEmailVerificationChallenge(user._id, '000000'),
                /Invalid or expired/
            );
            assert.strictEqual(observed.filter.emailVerificationChallengeId, user.emailVerificationChallengeId);
            assert.strictEqual(observed.filter.emailVerificationOtpDigest, user.emailVerificationOtpDigest);
            assert.deepStrictEqual(observed.update, { $inc: { emailVerificationAttempts: 1 } });
        });
    });

    await test('correct email OTP verifies and clears all challenge state', async () => {
        const user = activeEmailChallenge();
        let observed;
        await withUserMethods({
            findOne: () => selected(user),
            findOneAndUpdate: async (filter, update) => {
                observed = { filter, update };
                return { ...user, isEmailVerified: true };
            }
        }, async () => {
            const verified = await emailVerificationService.verifyEmailVerificationChallenge(user._id, user.testOtp);
            assert.strictEqual(verified.isEmailVerified, true);
            assert.deepStrictEqual(observed.update.$set, { isEmailVerified: true });
            for (const field of [
                'emailVerificationChallengeId',
                'emailVerificationOtpDigest',
                'emailVerificationEmail',
                'emailVerificationExpiresAt',
                'emailVerificationAttempts',
                'emailVerificationRequestedAt',
                'emailOtp',
                'emailOtpEmail',
                'emailOtpExpires',
                'emailOtpAttempts',
                'emailOtpRequestedAt'
            ]) {
                assert.strictEqual(observed.update.$unset[field], 1);
            }
        });
    });

    await test('expired email OTP cannot verify', async () => {
        const user = activeEmailChallenge({ emailVerificationExpiresAt: new Date(Date.now() - 1) });
        let writes = 0;
        await withUserMethods({
            findOne: () => selected(user),
            findOneAndUpdate: async () => { writes++; return user; }
        }, async () => {
            await assert.rejects(
                () => emailVerificationService.verifyEmailVerificationChallenge(user._id, user.testOtp),
                /Invalid or expired/
            );
            assert.strictEqual(writes, 0);
        });
    });

    await test('attempt exhaustion blocks even the correct OTP until legitimate reissue', async () => {
        const exhausted = activeEmailChallenge({
            emailVerificationAttempts: emailVerificationService.EMAIL_VERIFICATION_SECURITY.MAX_OTP_ATTEMPTS
        });
        let verificationWrites = 0;
        await withUserMethods({
            findOne: () => selected(exhausted),
            findOneAndUpdate: async () => { verificationWrites++; return exhausted; }
        }, async () => {
            await assert.rejects(
                () => emailVerificationService.verifyEmailVerificationChallenge(exhausted._id, exhausted.testOtp),
                /Invalid or expired/
            );
            assert.strictEqual(verificationWrites, 0);
        });

        const reissuable = {
            ...exhausted,
            emailVerificationRequestedAt: new Date(Date.now() - 2 * 60 * 1000)
        };
        let reissuedUpdate;
        await withUserMethods({
            findOne: () => selected(reissuable),
            findOneAndUpdate: (_filter, update) => {
                reissuedUpdate = update;
                return selected(reissuable);
            }
        }, async () => {
            await emailVerificationService.issueEmailVerificationChallenge(reissuable._id);
            assert.strictEqual(reissuedUpdate.$set.emailVerificationAttempts, 0);
            assert.notStrictEqual(reissuedUpdate.$set.emailVerificationOtpDigest, exhausted.emailVerificationOtpDigest);
        });
    });

    await test('email OTP routes use request and verification limiters', () => {
        const routeSource = fs.readFileSync(path.join(__dirname, '../routes/auth.js'), 'utf8');
        assert.match(routeSource, /email\/send-otp',\s*verifyJWT,\s*emailOtpRequestLimiter,\s*sendEmailOTP/);
        assert.match(routeSource, /email\/verify-otp',\s*verifyJWT,\s*emailOtpVerifyLimiter,\s*verifyEmailOTP/);
    });

    await test('failed email delivery invalidates the exact challenge and returns 502', async () => {
        const mailer = require('../utils/mailer');
        const sms = require('../utils/sms');
        const notificationService = require('../services/notification.service');
        const originals = {
            issue: emailVerificationService.issueEmailVerificationChallenge,
            invalidate: emailVerificationService.invalidateEmailVerificationChallenge,
            verify: emailVerificationService.verifyEmailVerificationChallenge,
            email: mailer.sendEmail,
            sms: sms.sendSMS,
            inApp: notificationService.sendInApp
        };
        const otp = '739104';
        let verifyCalls = 0;
        let invalidated;
        emailVerificationService.issueEmailVerificationChallenge = async () => ({
            user: activeEmailChallenge(),
            otp,
            challengeId: 'DELIVERY_CHALLENGE'
        });
        emailVerificationService.invalidateEmailVerificationChallenge = async (...args) => { invalidated = args; };
        emailVerificationService.verifyEmailVerificationChallenge = async () => { verifyCalls++; };
        mailer.sendEmail = async () => null;
        sms.sendSMS = async () => { throw new Error('email OTP must not use SMS'); };
        notificationService.sendInApp = async () => { throw new Error('email OTP must not use in-app delivery'); };
        delete require.cache[require.resolve('../controllers/authController')];
        try {
            const authController = require('../controllers/authController');
            const res = makeRes();
            await authController.sendEmailOTP({ user: { id: 'EMAIL_USER' } }, res);
            assert.strictEqual(res.statusCode, 502);
            assert.strictEqual(verifyCalls, 0);
            assert.deepStrictEqual(invalidated, ['EMAIL_USER', 'DELIVERY_CHALLENGE', 'user@example.test']);
            assert.ok(!JSON.stringify(res.body).includes(otp));
            assert.strictEqual(res.body.user, undefined);
        } finally {
            emailVerificationService.issueEmailVerificationChallenge = originals.issue;
            emailVerificationService.invalidateEmailVerificationChallenge = originals.invalidate;
            emailVerificationService.verifyEmailVerificationChallenge = originals.verify;
            mailer.sendEmail = originals.email;
            sms.sendSMS = originals.sms;
            notificationService.sendInApp = originals.inApp;
            delete require.cache[require.resolve('../controllers/authController')];
        }
    });

    await test('email OTP is delivered only to the challenge email', async () => {
        const mailer = require('../utils/mailer');
        const sms = require('../utils/sms');
        const notificationService = require('../services/notification.service');
        const originals = {
            issue: emailVerificationService.issueEmailVerificationChallenge,
            email: mailer.sendEmail,
            sms: sms.sendSMS,
            inApp: notificationService.sendInApp
        };
        let recipient;
        emailVerificationService.issueEmailVerificationChallenge = async () => ({
            user: activeEmailChallenge(),
            otp: '219047',
            challengeId: 'EMAIL_ONLY_CHALLENGE'
        });
        mailer.sendEmail = async to => { recipient = to; return { messageId: 'sent' }; };
        sms.sendSMS = async () => { throw new Error('email OTP must not use SMS'); };
        notificationService.sendInApp = async () => { throw new Error('email OTP must not use in-app delivery'); };
        delete require.cache[require.resolve('../controllers/authController')];
        try {
            const authController = require('../controllers/authController');
            const res = makeRes();
            await authController.sendEmailOTP({ user: { id: 'EMAIL_USER' } }, res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(recipient, 'user@example.test');
        } finally {
            emailVerificationService.issueEmailVerificationChallenge = originals.issue;
            mailer.sendEmail = originals.email;
            sms.sendSMS = originals.sms;
            notificationService.sendInApp = originals.inApp;
            delete require.cache[require.resolve('../controllers/authController')];
        }
    });

    await test('SMTP transport validates server certificates', () => {
        const mailerSource = fs.readFileSync(path.join(__dirname, '../utils/mailer.js'), 'utf8');
        assert.doesNotMatch(mailerSource, /rejectUnauthorized\s*:\s*false/);
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
