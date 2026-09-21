'use strict';

const dotenv = require('dotenv');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

const CONFIRMATION_VALUE = 'create-initial-superadmin';
const BCRYPT_COST = 12;

class BootstrapError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'BootstrapError';
        this.accountMayExist = options.accountMayExist === true;
    }
}

function hasExplicitDatabaseName(uri) {
    if (typeof uri !== 'string' || !/^mongodb(?:\+srv)?:\/\//i.test(uri)) return false;
    const withoutQuery = uri.split('?')[0];
    const authorityStart = withoutQuery.indexOf('://') + 3;
    const pathStart = withoutQuery.indexOf('/', authorityStart);
    if (pathStart < 0) return false;
    return withoutQuery.slice(pathStart + 1).split('/')[0].trim().length > 0;
}

function validateBootstrapEnvironment(env = {}) {
    const mongoUri = typeof env.MONGO_URI === 'string' ? env.MONGO_URI.trim() : '';
    if (!mongoUri) throw new BootstrapError('MONGO_URI is required.');
    if (!hasExplicitDatabaseName(mongoUri)) {
        throw new BootstrapError('MONGO_URI must include an explicit database name.');
    }

    if (env.BOOTSTRAP_SUPERADMIN_CONFIRM !== CONFIRMATION_VALUE) {
        throw new BootstrapError(
            `BOOTSTRAP_SUPERADMIN_CONFIRM must exactly equal "${CONFIRMATION_VALUE}".`
        );
    }

    const name = typeof env.BOOTSTRAP_SUPERADMIN_NAME === 'string'
        ? env.BOOTSTRAP_SUPERADMIN_NAME.trim()
        : '';
    const phone = typeof env.BOOTSTRAP_SUPERADMIN_PHONE === 'string'
        ? env.BOOTSTRAP_SUPERADMIN_PHONE.trim()
        : '';
    const password = typeof env.BOOTSTRAP_SUPERADMIN_PASSWORD === 'string'
        ? env.BOOTSTRAP_SUPERADMIN_PASSWORD
        : '';
    const email = typeof env.BOOTSTRAP_SUPERADMIN_EMAIL === 'string'
        ? env.BOOTSTRAP_SUPERADMIN_EMAIL.trim().toLowerCase()
        : '';

    if (!name) throw new BootstrapError('BOOTSTRAP_SUPERADMIN_NAME is required.');
    if (!phone) throw new BootstrapError('BOOTSTRAP_SUPERADMIN_PHONE is required.');
    if (!password) throw new BootstrapError('BOOTSTRAP_SUPERADMIN_PASSWORD is required.');

    return {
        mongoUri,
        name,
        phone,
        password,
        ...(email ? { email } : {})
    };
}

function verifyPersistedUser(user, expected) {
    if (!user || !user._id || String(user._id) !== String(expected._id)) return false;
    if (user.status !== true || user.role !== 'superAdmin') return false;
    if (!Array.isArray(user.roles) || !user.roles.includes('superAdmin')) return false;
    if (user.phone !== expected.phone) return false;
    if (expected.email && user.email !== expected.email) return false;
    return true;
}

async function bootstrapSuperAdmin(config, dependencies = {}) {
    const UserModel = dependencies.UserModel || User;
    const bcryptModule = dependencies.bcryptModule || bcrypt;

    let existingSuperAdmin;
    try {
        existingSuperAdmin = await UserModel.exists({
            $or: [{ role: 'superAdmin' }, { roles: 'superAdmin' }]
        });
    } catch (_) {
        throw new BootstrapError('Unable to check for an existing SuperAdmin.');
    }
    if (existingSuperAdmin) {
        throw new BootstrapError('A SuperAdmin already exists; bootstrap is not permitted.');
    }

    const duplicateFilters = [{ phone: config.phone }];
    if (config.email) duplicateFilters.push({ email: config.email });

    let duplicateIdentity;
    try {
        duplicateIdentity = await UserModel.exists({ $or: duplicateFilters });
    } catch (_) {
        throw new BootstrapError('Unable to check the requested bootstrap identity.');
    }
    if (duplicateIdentity) {
        throw new BootstrapError('The requested bootstrap phone or email already exists.');
    }

    let hashedPassword;
    try {
        hashedPassword = await bcryptModule.hash(config.password, BCRYPT_COST);
    } catch (_) {
        throw new BootstrapError('Unable to hash the bootstrap password.');
    }

    const userData = {
        name: config.name,
        phone: config.phone,
        password: hashedPassword,
        status: true,
        role: 'superAdmin',
        roles: ['superAdmin'],
        ...(config.email ? { email: config.email } : {})
    };

    let created;
    try {
        created = await UserModel.create(userData);
    } catch (error) {
        if (error && error.code === 11000) {
            throw new BootstrapError('The requested bootstrap phone or email already exists.');
        }
        throw new BootstrapError('Unable to create the bootstrap SuperAdmin.');
    }

    let persisted;
    try {
        persisted = await UserModel.findById(created._id)
            .select('_id name phone email status role roles');
    } catch (_) {
        throw new BootstrapError(
            'Post-creation verification failed; the account may have been created.',
            { accountMayExist: true }
        );
    }

    const expected = {
        _id: created._id,
        phone: config.phone,
        ...(config.email ? { email: config.email } : {})
    };
    if (!verifyPersistedUser(persisted, expected)) {
        throw new BootstrapError(
            'Post-creation verification failed; the account may have been created.',
            { accountMayExist: true }
        );
    }

    return persisted;
}

function maskPhone(phone) {
    const value = String(phone || '');
    if (value.length <= 4) return '*'.repeat(Math.max(value.length, 4));
    return `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
}

function maskEmail(email) {
    const value = String(email || '');
    const at = value.indexOf('@');
    if (at <= 0) return value ? '***' : '';
    return `${value[0]}***${value.slice(at)}`;
}

async function runCli(options = {}) {
    const env = options.env || process.env;
    const mongooseInstance = options.mongooseInstance || mongoose;
    const logger = options.logger || console;
    const config = validateBootstrapEnvironment(env);
    let connectionAttempted = false;
    let operationError = null;

    try {
        connectionAttempted = true;
        try {
            await mongooseInstance.connect(config.mongoUri, {
                autoIndex: false,
                autoCreate: false
            });
        } catch (_) {
            throw new BootstrapError('Unable to connect to the configured database.');
        }

        const user = await bootstrapSuperAdmin(config, {
            UserModel: options.UserModel || User,
            bcryptModule: options.bcryptModule || bcrypt
        });

        logger.log('SuperAdmin bootstrap completed.');
        logger.log(`User ID: ${user._id}`);
        logger.log(`Account name: ${user.name || config.name}`);
        logger.log(`Phone: ${maskPhone(user.phone)}`);
        if (user.email) logger.log(`Email: ${maskEmail(user.email)}`);
        logger.log('Active SuperAdmin role verified.');
        return user;
    } catch (error) {
        operationError = error;
        throw error;
    } finally {
        if (connectionAttempted) {
            try {
                await mongooseInstance.disconnect();
            } catch (_) {
                if (!operationError) {
                    throw new BootstrapError('SuperAdmin was created, but database disconnect failed.', {
                        accountMayExist: true
                    });
                }
            }
        }
    }
}

function safeErrorMessage(error) {
    if (error instanceof BootstrapError) return error.message;
    return 'Bootstrap failed due to an unexpected database or validation error.';
}

if (require.main === module) {
    dotenv.config();
    runCli().catch(error => {
        console.error(`[SuperAdmin Bootstrap] ${safeErrorMessage(error)}`);
        process.exitCode = 1;
    });
}

module.exports = {
    BCRYPT_COST,
    CONFIRMATION_VALUE,
    BootstrapError,
    hasExplicitDatabaseName,
    validateBootstrapEnvironment,
    verifyPersistedUser,
    bootstrapSuperAdmin,
    maskPhone,
    maskEmail,
    runCli,
    safeErrorMessage
};
