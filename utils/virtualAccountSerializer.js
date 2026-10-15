'use strict';

const VIRTUAL_ACCOUNT_FIELDS = Object.freeze([
    '_id',
    'provider',
    'bankName',
    'bankCode',
    'bankSlug',
    'accountName',
    'accountNumber',
    'currency',
    'active',
    'assigned',
    'provisioningStatus'
]);

const LINKED_ACCOUNT_FIELDS = Object.freeze([
    '_id',
    'bankName',
    'bankCode',
    'accountName',
    'accountNumber',
    'isDefault'
]);

const PROFILE_FIELDS = Object.freeze([
    '_id',
    'id',
    'name',
    'email',
    'phone',
    'phoneNumber',
    'role',
    'roles',
    'isPinSet',
    'hasPIN',
    'transaction_pin_set',
    'isPhoneVerified',
    'isEmailVerified',
    'kycLevel',
    'kycStatus',
    'myReferralCode',
    'totalReferralBonus',
    'referralBalance',
    'totalReferrals',
    'lastLogin'
]);

const ADMIN_USER_FIELDS = Object.freeze([
    '_id',
    'id',
    'name',
    'email',
    'phone',
    'role',
    'roles',
    'accountType',
    'status',
    'referrerCode',
    'referredBy',
    'myReferralCode',
    'commissionRate',
    'totalReferralBonus',
    'referralBalance',
    'firstFundingBonusProcessed',
    'resellerEarnings',
    'isShareholder',
    'sharesOwned',
    'dividendBalance',
    'totalDividendsEarned',
    'firstSharePurchasedAt',
    'frozenShares',
    'isPinSet',
    'kycLevel',
    'isPhoneVerified',
    'isEmailVerified',
    'lastLogin',
    'createdAt',
    'updatedAt',
    'balance',
    'transactions',
    'stats'
]);

const toPlainObject = value => {
    if (!value) return {};
    if (typeof value.toObject === 'function') {
        return value.toObject({ depopulate: true, flattenMaps: true });
    }
    return value;
};

const isUsableVirtualAccount = value => {
    const account = toPlainObject(value);
    return ['paystack', 'monnify'].includes(String(account.provider || '').toLowerCase())
        && !!account.gatewayId
        && !!account.accountReference
        && !!String(account.bankName || '').trim()
        && !!String(account.accountName || '').trim()
        && !!account.accountNumber
        && account.currency === 'NGN'
        && account.active === true
        && account.assigned === true
        && account.provisioningStatus === 'active';
};

const pickDefined = (value, fields) => {
    const source = toPlainObject(value);
    const result = {};
    for (const field of fields) {
        if (source[field] !== undefined) result[field] = source[field];
    }
    return result;
};

const serializeVirtualAccount = account => {
    const serialized = pickDefined(account, VIRTUAL_ACCOUNT_FIELDS);

    if (serialized._id !== undefined) serialized._id = String(serialized._id);

    return serialized;
};

const serializeVirtualAccounts = accounts => (
    Array.isArray(accounts)
        ? accounts.filter(isUsableVirtualAccount).map(serializeVirtualAccount)
        : []
);

const serializeLinkedAccounts = accounts => (
    Array.isArray(accounts) ? accounts.map(account => pickDefined(account, LINKED_ACCOUNT_FIELDS)) : []
);

const serializeUserProfile = user => {
    const source = toPlainObject(user);
    const serialized = pickDefined(source, PROFILE_FIELDS);

    if (source._id !== undefined) {
        serialized._id = String(source._id);
        if (serialized.id === undefined) serialized.id = serialized._id;
    }
    serialized.virtualAccounts = serializeVirtualAccounts(source.virtualAccounts);
    serialized.linkedAccounts = serializeLinkedAccounts(source.linkedAccounts);

    return serialized;
};

const serializeAdminUser = user => {
    const source = toPlainObject(user);
    const serialized = pickDefined(source, ADMIN_USER_FIELDS);

    if (source._id !== undefined) {
        serialized._id = String(source._id);
        if (serialized.id === undefined) serialized.id = serialized._id;
    }
    serialized.virtualAccounts = serializeVirtualAccounts(source.virtualAccounts);
    serialized.linkedAccounts = serializeLinkedAccounts(source.linkedAccounts);

    return serialized;
};

const serializeAdminUsers = users => (
    Array.isArray(users) ? users.map(serializeAdminUser) : []
);

module.exports = {
    serializeVirtualAccount,
    serializeVirtualAccounts,
    isUsableVirtualAccount,
    serializeUserProfile,
    serializeAdminUser,
    serializeAdminUsers
};
