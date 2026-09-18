const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const TOKEN_PURPOSES = Object.freeze({
    ACCESS: 'access',
    PASSWORD_RESET: 'password_reset',
    EMAIL_VERIFICATION: 'email_verification'
});

const LEGACY_ACCESS_DURATIONS = new Set([
    7 * 24 * 60 * 60,
    30 * 24 * 60 * 60
]);

const hasOwn = (value, property) => Object.prototype.hasOwnProperty.call(value, property);

const invalidTokenPurpose = message => {
    const error = new Error(message);
    error.code = 'TOKEN_PURPOSE_MISMATCH';
    return error;
};

const hasValidNumericDates = decoded => Number.isSafeInteger(decoded?.iat) &&
    Number.isSafeInteger(decoded?.exp) && decoded.exp > decoded.iat;

const authVersionOf = user => Number.isSafeInteger(user?.authVersion) && user.authVersion >= 0
    ? user.authVersion
    : 0;

const identityClaims = user => ({
    sub: String(user._id),
    id: String(user._id),
    email: user.email,
    authVersion: authVersionOf(user)
});

const generateAccessToken = (user, expiresIn = '7d') => {
    const userRoleString = user.role ? [user.role] : [];
    const userRolesArray = Array.isArray(user.roles) ? user.roles : [];
    let roles = [...new Set([...userRoleString, ...userRolesArray])];
    if (roles.length === 0) roles = ['user'];

    const perms = user.perms ?? undefined;
    return jwt.sign(
        {
            ...identityClaims(user),
            purpose: TOKEN_PURPOSES.ACCESS,
            roles,
            ...(perms ? { perms } : {})
        },
        process.env.JWT_SECRET,
        { expiresIn }
    );
};

const generatePasswordResetToken = (user, jti, expiresIn = '10m') => jwt.sign(
    {
        ...identityClaims(user),
        purpose: TOKEN_PURPOSES.PASSWORD_RESET,
        jti
    },
    process.env.JWT_SECRET,
    { expiresIn }
);

const generateEmailVerificationToken = (user, expiresIn = '30m') => jwt.sign(
    {
        ...identityClaims(user),
        purpose: TOKEN_PURPOSES.EMAIL_VERIFICATION,
        jti: crypto.randomUUID()
    },
    process.env.JWT_SECRET,
    { expiresIn }
);

const verifyPurposeToken = (token, expectedPurpose) => {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.purpose !== expectedPurpose || !decoded.sub || decoded.id !== decoded.sub ||
        !hasValidNumericDates(decoded) || !Number.isSafeInteger(decoded.authVersion) || decoded.authVersion < 0) {
        throw invalidTokenPurpose('Invalid token purpose');
    }
    return decoded;
};

const verifyAccessToken = token => {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (hasOwn(decoded, 'purpose')) {
        if (decoded.purpose !== TOKEN_PURPOSES.ACCESS || !decoded.sub || decoded.id !== decoded.sub ||
            !hasValidNumericDates(decoded) || !Number.isSafeInteger(decoded.authVersion) || decoded.authVersion < 0) {
            throw invalidTokenPurpose('Invalid token purpose');
        }
        return decoded;
    }

    // Historical production access tokens were untyped and lasted exactly 7 or
    // 30 days. Historical reset tokens were also untyped but lasted 15 minutes.
    const duration = decoded.exp - decoded.iat;
    if (!hasValidNumericDates(decoded) || !LEGACY_ACCESS_DURATIONS.has(duration)) {
        throw invalidTokenPurpose('Invalid legacy access token');
    }
    return decoded;
};

const authVersionFilter = version => {
    const normalized = Number.isSafeInteger(version) && version >= 0 ? version : 0;
    if (normalized === 0) {
        return { $or: [{ authVersion: 0 }, { authVersion: { $exists: false } }] };
    }
    return { authVersion: normalized };
};

module.exports = {
    TOKEN_PURPOSES,
    authVersionOf,
    authVersionFilter,
    generateAccessToken,
    generatePasswordResetToken,
    generateEmailVerificationToken,
    verifyPurposeToken,
    verifyAccessToken
};
