'use strict';

function explicitDatabaseNameFromUri(uri) {
    if (typeof uri !== 'string' || !/^mongodb(?:\+srv)?:\/\//i.test(uri)) return '';
    const withoutQuery = uri.split('?')[0];
    const authorityStart = withoutQuery.indexOf('://') + 3;
    const pathStart = withoutQuery.indexOf('/', authorityStart);
    if (pathStart < 0) return '';
    const databaseName = withoutQuery.slice(pathStart + 1).trim();
    if (!databaseName) return '';
    try {
        return decodeURIComponent(databaseName);
    } catch (_) {
        throw new Error('MONGO_URI contains an invalid database name');
    }
}

function hasExplicitDatabaseName(uri) {
    return Boolean(explicitDatabaseNameFromUri(uri));
}

function requiresExpectedDatabaseName({ nodeEnv, apply = false } = {}) {
    const environment = typeof nodeEnv === 'string' ? nodeEnv.trim().toLowerCase() : '';
    return apply || environment === 'production' || environment === 'staging';
}

function validateDatabaseTargetConfiguration({
    mongoUri,
    databaseName,
    expectedDatabaseName,
    nodeEnv,
    apply = false
} = {}) {
    if (!mongoUri) throw new Error('MONGO_URI is required');
    const uriDatabaseName = explicitDatabaseNameFromUri(mongoUri);
    const configuredDatabaseName = typeof databaseName === 'string' ? databaseName.trim() : '';
    if (!uriDatabaseName && !configuredDatabaseName) {
        throw new Error('MONGO_DB_NAME is required when MONGO_URI does not include a database name');
    }
    if (uriDatabaseName && configuredDatabaseName && uriDatabaseName !== configuredDatabaseName) {
        throw new Error('MONGO_DB_NAME does not match the database selected by MONGO_URI');
    }

    const expected = typeof expectedDatabaseName === 'string'
        ? expectedDatabaseName.trim()
        : '';
    if (!expected && requiresExpectedDatabaseName({ nodeEnv, apply })) {
        throw new Error('EXPECTED_DB_NAME is required in production/staging and for --apply');
    }
    const selectedDatabaseName = uriDatabaseName || configuredDatabaseName;
    if (expected && selectedDatabaseName !== expected) {
        throw new Error('Configured database does not match EXPECTED_DB_NAME');
    }
    return expected || selectedDatabaseName;
}

function databaseTargetConnectionOptions({ mongoUri, databaseName } = {}) {
    if (hasExplicitDatabaseName(mongoUri)) return {};
    const configuredDatabaseName = typeof databaseName === 'string' ? databaseName.trim() : '';
    return configuredDatabaseName ? { dbName: configuredDatabaseName } : {};
}

function assertConnectedDatabaseName(connectedDatabaseName, expectedDatabaseName) {
    if (!expectedDatabaseName) return;
    if (connectedDatabaseName !== expectedDatabaseName) {
        throw new Error('Connected database does not match EXPECTED_DB_NAME');
    }
}

function sanitizeDatabaseErrorMessage(error, mongoUri) {
    let message = error && error.message ? String(error.message) : String(error || 'Unknown database error');
    const sensitiveValues = [];

    if (typeof mongoUri === 'string' && mongoUri) {
        sensitiveValues.push(mongoUri);
        const authority = mongoUri.match(/^mongodb(?:\+srv)?:\/\/([^/]+)/i)?.[1] || '';
        const userInfoEnd = authority.lastIndexOf('@');
        if (userInfoEnd >= 0) {
            const [username, ...passwordParts] = authority.slice(0, userInfoEnd).split(':');
            sensitiveValues.push(username, passwordParts.join(':'));
            try {
                sensitiveValues.push(decodeURIComponent(username), decodeURIComponent(passwordParts.join(':')));
            } catch (_) {
                // The exact encoded values are still redacted below.
            }
        }
    }

    for (const value of [...new Set(sensitiveValues.filter(Boolean))].sort((a, b) => b.length - a.length)) {
        message = message.split(value).join('[REDACTED]');
    }
    return message.replace(/mongodb(?:\+srv)?:\/\/[^\s"'`]+/gi, '[REDACTED_MONGO_URI]');
}

module.exports = {
    explicitDatabaseNameFromUri,
    hasExplicitDatabaseName,
    requiresExpectedDatabaseName,
    validateDatabaseTargetConfiguration,
    databaseTargetConnectionOptions,
    assertConnectedDatabaseName,
    sanitizeDatabaseErrorMessage
};
