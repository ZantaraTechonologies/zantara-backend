'use strict';

const { normalizeTermiiPhone } = require('./sms');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeCustomerPhone(phone) {
    const value = typeof phone === 'string' ? phone.trim() : '';
    if (!value) return '';
    try {
        return normalizeTermiiPhone(value);
    } catch (_) {
        return value;
    }
}

function phoneIdentityCandidates(phone) {
    const canonical = normalizeTermiiPhone(phone);
    const subscriber = canonical.slice(3);
    return [canonical, `+${canonical}`, `0${subscriber}`];
}

function normalizeCustomerProfile({ name, email, phone } = {}) {
    return {
        name: typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '',
        email: typeof email === 'string' ? email.trim().toLowerCase() : '',
        phone: normalizeCustomerPhone(phone)
    };
}

function validateCustomerProfile(profile = {}) {
    const normalized = normalizeCustomerProfile(profile);
    const missingFields = [];
    const invalidFields = [];

    if (!normalized.name) missingFields.push('name');
    else if (normalized.name.length < 2 || normalized.name.length > 120 || /[\u0000-\u001f\u007f]/.test(normalized.name)) {
        invalidFields.push('name');
    }

    if (!normalized.email) missingFields.push('email');
    else if (normalized.email.length > 254 || !EMAIL_RE.test(normalized.email)) invalidFields.push('email');

    if (!normalized.phone) missingFields.push('phone');
    else {
        try {
            normalizeTermiiPhone(normalized.phone);
        } catch (_) {
            invalidFields.push('phone');
        }
    }

    return {
        normalized,
        complete: missingFields.length === 0 && invalidFields.length === 0,
        missingFields,
        invalidFields
    };
}

module.exports = {
    EMAIL_RE,
    normalizeCustomerPhone,
    phoneIdentityCandidates,
    normalizeCustomerProfile,
    validateCustomerProfile
};
