'use strict';

function hasExplicitDatabaseName(uri) {
    if (typeof uri !== 'string' || !/^mongodb(?:\+srv)?:\/\//i.test(uri)) return false;
    const withoutQuery = uri.split('?')[0];
    const authorityStart = withoutQuery.indexOf('://') + 3;
    const pathStart = withoutQuery.indexOf('/', authorityStart);
    return pathStart >= 0 && withoutQuery.slice(pathStart + 1).trim().length > 0;
}

function requiresExpectedDatabaseName({ nodeEnv, apply = false } = {}) {
    return apply || nodeEnv === 'production' || nodeEnv === 'staging';
}

function validateDatabaseTargetConfiguration({
    mongoUri,
    expectedDatabaseName,
    nodeEnv,
    apply = false
} = {}) {
    if (!mongoUri) throw new Error('MONGO_URI is required');
    if (!hasExplicitDatabaseName(mongoUri)) {
        throw new Error('MONGO_URI must explicitly include the approved target database name');
    }

    const expected = typeof expectedDatabaseName === 'string'
        ? expectedDatabaseName.trim()
        : '';
    if (!expected && requiresExpectedDatabaseName({ nodeEnv, apply })) {
        throw new Error('EXPECTED_DB_NAME is required in production/staging and for --apply');
    }
    return expected;
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
    hasExplicitDatabaseName,
    requiresExpectedDatabaseName,
    validateDatabaseTargetConfiguration,
    assertConnectedDatabaseName,
    sanitizeDatabaseErrorMessage
};
