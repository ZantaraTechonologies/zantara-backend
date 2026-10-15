'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    onboardingConfigForMode,
    resolveEffectiveOnboardingMode
} = require('../config/onboarding');
const {
    OnboardingConfigService,
    SETTING_KEY,
    SETTING_ID
} = require('../services/onboardingConfig.service');

const fakeService = ({ ceiling = 'new_users', initial = null, auditFails = false } = {}) => {
    let record = initial === null ? null : {
        _id: SETTING_ID,
        key: SETTING_KEY,
        value: initial,
        async save() { return this; }
    };
    const audits = [];
    const settingModel = {
        findById: async () => record,
        findOneAndUpdate: async (_filter, update) => {
            if (!record) {
                record = {
                    _id: SETTING_ID,
                    key: update.$setOnInsert.key,
                    value: update.$setOnInsert.value,
                    async save() { return this; }
                };
            }
            return record;
        }
    };
    const auditLogModel = {
        create: async rows => {
            if (auditFails) throw new Error('audit unavailable');
            audits.push(...rows);
            return rows;
        }
    };
    const session = {
        async withTransaction(operation) { return operation(); },
        async endSession() {}
    };
    const mongooseInstance = {
        connection: { readyState: 1 },
        startSession: async () => session
    };
    const service = new OnboardingConfigService({
        settingModel,
        auditLogModel,
        mongooseInstance,
        environmentConfig: () => onboardingConfigForMode(ceiling),
        allowDisconnectedTestFallback: false
    });
    return { service, audits, getRecord: () => record };
};

test('effective onboarding mode never exceeds the environment ceiling', () => {
    assert.equal(resolveEffectiveOnboardingMode('new_users', 'off'), 'off');
    assert.equal(resolveEffectiveOnboardingMode('new_users', 'observe'), 'observe');
    assert.equal(resolveEffectiveOnboardingMode('observe', 'new_users'), 'observe');
    assert.equal(resolveEffectiveOnboardingMode('off', 'new_users'), 'off');
});

test('missing database setting initializes to off without enabling enrollment', async () => {
    const { service, getRecord } = fakeService({ ceiling: 'new_users' });
    const config = await service.initialize();
    assert.equal(getRecord().key, SETTING_KEY);
    assert.equal(config.databaseMode, 'off');
    assert.equal(config.effectiveMode, 'off');
    assert.equal(config.enrollNewUsers, false);
});

test('confirmed mode change persists and writes a complete audit record', async () => {
    const { service, audits, getRecord } = fakeService({ ceiling: 'new_users', initial: 'off' });
    const config = await service.changeMode({
        mode: 'observe',
        expectedCurrentMode: 'off',
        confirmation: 'off-to-observe',
        actor: { id: '507f1f77bcf86cd799439011', name: 'Super Admin' },
        request: { ip: '127.0.0.1', headers: { 'user-agent': 'test' } }
    });
    assert.equal(getRecord().value, 'observe');
    assert.equal(config.effectiveMode, 'observe');
    assert.equal(config.changed, true);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'ONBOARDING_ENFORCEMENT_MODE_CHANGED');
    assert.deepEqual(audits[0].details, {
        previousDatabaseMode: 'off',
        newDatabaseMode: 'observe',
        environmentCeilingMode: 'new_users',
        previousEffectiveMode: 'off',
        newEffectiveMode: 'observe',
        policyVersion: 1
    });
});

test('stale, unconfirmed, and above-ceiling mode changes are rejected', async () => {
    const stored = fakeService({ ceiling: 'new_users', initial: 'observe' }).service;
    await assert.rejects(
        () => stored.changeMode({ mode: 'new_users', expectedCurrentMode: 'off', confirmation: 'off-to-new_users' }),
        error => error.code === 'ONBOARDING_SETTING_STALE'
    );
    await assert.rejects(
        () => stored.changeMode({ mode: 'new_users', expectedCurrentMode: 'observe', confirmation: '' }),
        error => error.code === 'ONBOARDING_SETTING_CONFIRMATION_REQUIRED'
    );

    const capped = fakeService({ ceiling: 'observe', initial: 'off' }).service;
    await assert.rejects(
        () => capped.changeMode({ mode: 'new_users', expectedCurrentMode: 'off', confirmation: 'off-to-new_users' }),
        error => error.code === 'ONBOARDING_MODE_ABOVE_ENVIRONMENT_CEILING'
    );
});

test('audit failure rejects the requested setting change', async () => {
    const { service } = fakeService({ ceiling: 'new_users', initial: 'off', auditFails: true });
    await assert.rejects(
        () => service.changeMode({
            mode: 'observe',
            expectedCurrentMode: 'off',
            confirmation: 'off-to-observe',
            actor: { id: '507f1f77bcf86cd799439011' }
        }),
        /audit unavailable/
    );
});

test('onboarding routes are SuperAdmin-only and generic settings cannot mutate the reserved key', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
    const controller = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'adminController.js'), 'utf8');
    const publicSettings = fs.readFileSync(path.join(__dirname, '..', 'routes', 'settings.js'), 'utf8');
    assert.match(routes, /get\('\/settings\/onboarding', checkRoles\('superAdmin'\)/);
    assert.match(routes, /put\('\/settings\/onboarding', checkRoles\('superAdmin'\)/);
    assert.match(controller, /key === 'ONBOARDING_ENFORCEMENT_MODE'/);
    assert.doesNotMatch(publicSettings, /ONBOARDING_ENFORCEMENT_MODE/);
});
