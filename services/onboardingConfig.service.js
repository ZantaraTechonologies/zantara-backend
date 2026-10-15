'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const Setting = require('../models/Setting');
const AuditLog = require('../models/AuditLog');
const {
    ONBOARDING_ENFORCEMENT_MODES,
    ONBOARDING_MODE_RANK,
    getOnboardingConfig,
    resolveEffectiveOnboardingMode,
    onboardingConfigForMode
} = require('../config/onboarding');

const SETTING_KEY = 'ONBOARDING_ENFORCEMENT_MODE';
const SETTING_ID = new mongoose.Types.ObjectId(
    crypto.createHash('sha256').update(`setting:${SETTING_KEY}`).digest('hex').slice(0, 24)
);

const configurationError = message => {
    const error = new Error(message);
    error.code = 'ONBOARDING_CONFIGURATION_INVALID';
    error.statusCode = 503;
    return error;
};

const conflictError = (message, code = 'ONBOARDING_SETTING_CONFLICT') => {
    const error = new Error(message);
    error.code = code;
    error.statusCode = 409;
    return error;
};

class OnboardingConfigService {
    constructor(options = {}) {
        this.Setting = options.settingModel || Setting;
        this.AuditLog = options.auditLogModel || AuditLog;
        this.mongoose = options.mongooseInstance || mongoose;
        this.readEnvironmentConfig = options.environmentConfig || getOnboardingConfig;
        this.allowDisconnectedTestFallback = options.allowDisconnectedTestFallback
            ?? !options.settingModel;
    }

    _environmentConfig() {
        return this.readEnvironmentConfig();
    }

    _compose(databaseMode, environment = this._environmentConfig()) {
        const normalizedDatabaseMode = String(databaseMode || '').trim().toLowerCase();
        if (!ONBOARDING_ENFORCEMENT_MODES.includes(normalizedDatabaseMode)) {
            throw configurationError('Stored onboarding enforcement mode is invalid');
        }
        const effectiveMode = resolveEffectiveOnboardingMode(normalizedDatabaseMode, environment.mode);
        return onboardingConfigForMode(effectiveMode, {
            databaseMode: normalizedDatabaseMode,
            environmentCeilingMode: environment.mode,
            effectiveMode,
            capped: effectiveMode !== normalizedDatabaseMode
        });
    }

    async _storedMode({ session = null } = {}) {
        let query = this.Setting.findById(SETTING_ID);
        if (session && typeof query?.session === 'function') query = query.session(session);
        const record = await query;
        if (!record) return 'off';
        if (record.key !== SETTING_KEY) {
            throw configurationError('Reserved onboarding setting identity is invalid');
        }
        return record.value;
    }

    async getConfig() {
        const environment = this._environmentConfig();
        // Hermetic unit tests that do not create a Mongo connection retain the
        // explicit test environment mode. Dedicated setting tests exercise the
        // database-backed service through injected models.
        if (this.allowDisconnectedTestFallback
            && process.env.NODE_ENV === 'test'
            && this.mongoose.connection?.readyState !== 1) {
            return this._compose(environment.mode, environment);
        }
        return this._compose(await this._storedMode(), environment);
    }

    async initialize() {
        await this.Setting.findOneAndUpdate(
            { _id: SETTING_ID },
            { $setOnInsert: { key: SETTING_KEY, value: 'off' } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        return this._compose(await this._storedMode());
    }

    async changeMode({ mode, expectedCurrentMode, confirmation, actor, request } = {}) {
        const requestedMode = String(mode || '').trim().toLowerCase();
        const expectedMode = String(expectedCurrentMode || '').trim().toLowerCase();
        if (!ONBOARDING_ENFORCEMENT_MODES.includes(requestedMode)) {
            const error = new Error(`Mode must be one of: ${ONBOARDING_ENFORCEMENT_MODES.join(', ')}`);
            error.code = 'ONBOARDING_MODE_INVALID';
            error.statusCode = 400;
            throw error;
        }
        if (!ONBOARDING_ENFORCEMENT_MODES.includes(expectedMode)) {
            throw conflictError('The expected current onboarding mode is invalid');
        }

        const environment = this._environmentConfig();
        if (ONBOARDING_MODE_RANK[requestedMode] > ONBOARDING_MODE_RANK[environment.mode]) {
            throw conflictError(
                `Deployment configuration permits at most ${environment.mode}`,
                'ONBOARDING_MODE_ABOVE_ENVIRONMENT_CEILING'
            );
        }

        const session = await this.mongoose.startSession();
        let changed = false;
        try {
            await session.withTransaction(async () => {
                let query = this.Setting.findOneAndUpdate(
                    { _id: SETTING_ID },
                    { $setOnInsert: { key: SETTING_KEY, value: 'off' } },
                    { upsert: true, new: true, setDefaultsOnInsert: true, session }
                );
                const current = await query;
                if (current.key !== SETTING_KEY) {
                    throw configurationError('Reserved onboarding setting identity is invalid');
                }
                const currentMode = String(current.value || '').trim().toLowerCase();
                if (!ONBOARDING_ENFORCEMENT_MODES.includes(currentMode)) {
                    throw configurationError('Stored onboarding enforcement mode is invalid');
                }
                if (currentMode !== expectedMode) {
                    throw conflictError(
                        'Onboarding mode changed since it was loaded. Refresh and try again.',
                        'ONBOARDING_SETTING_STALE'
                    );
                }
                if (currentMode === requestedMode) return;

                const requiredConfirmation = `${currentMode}-to-${requestedMode}`;
                if (confirmation !== requiredConfirmation) {
                    throw conflictError(
                        'Changing onboarding enforcement requires explicit confirmation.',
                        'ONBOARDING_SETTING_CONFIRMATION_REQUIRED'
                    );
                }

                const previous = this._compose(currentMode, environment);
                const next = this._compose(requestedMode, environment);
                current.value = requestedMode;
                await current.save({ session });
                await this.AuditLog.create([{
                    adminId: actor?.id,
                    operatorName: actor?.name,
                    action: 'ONBOARDING_ENFORCEMENT_MODE_CHANGED',
                    target: SETTING_KEY,
                    details: {
                        previousDatabaseMode: currentMode,
                        newDatabaseMode: requestedMode,
                        environmentCeilingMode: environment.mode,
                        previousEffectiveMode: previous.effectiveMode,
                        newEffectiveMode: next.effectiveMode,
                        policyVersion: next.policyVersion
                    },
                    ipAddress: request?.ip || request?.headers?.['x-forwarded-for'],
                    userAgent: request?.headers?.['user-agent'],
                    result: 'success'
                }], { session });
                changed = true;
            });
        } finally {
            await session.endSession();
        }

        return { ...(await this.getConfig()), changed };
    }
}

const service = new OnboardingConfigService();
module.exports = service;
module.exports.OnboardingConfigService = OnboardingConfigService;
module.exports.SETTING_KEY = SETTING_KEY;
module.exports.SETTING_ID = SETTING_ID;
