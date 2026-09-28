const policyError = message => {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
};

const isSafeIdentifierPattern = pattern => {
    if (typeof pattern !== 'string' || pattern.length > 256) return false;
    if (/[()|*+?]/.test(pattern) || /\\[1-9]/.test(pattern) || /\(\?/.test(pattern)
        || /\{\d+,\}/.test(pattern) || !pattern.startsWith('^') || !pattern.endsWith('$')
        || /(^|[^\\])\./.test(pattern)) return false;
    const ranges = [...pattern.matchAll(/\{(\d+),(\d+)\}/g)];
    if (ranges.length > 1 || ranges.some(match => Number(match[1]) > Number(match[2]) || Number(match[2]) > 256)) {
        return false;
    }
    const fixedQuantifiers = [...pattern.matchAll(/\{(\d+)\}/g)];
    if (fixedQuantifiers.some(match => Number(match[1]) > 256)) return false;
    try {
        new RegExp(pattern);
        return true;
    } catch (_) {
        return false;
    }
};

const normalizeIdentifier = (value, policy) => {
    if (typeof value !== 'string') throw policyError('Customer identifier is required');
    if (!policy?.label) throw policyError('Customer identifier policy is not configured');
    if (value.length > 512) throw policyError('Customer identifier is too long');

    const normalization = policy.normalization || 'trim';
    let normalized = value;
    if (normalization === 'trim') normalized = value.trim();
    if (normalization === 'lowercase') normalized = value.trim().toLowerCase();
    if (normalization === 'uppercase') normalized = value.trim().toUpperCase();
    if (normalization === 'digits_only') {
        if (!/^[\d\s()+-]+$/.test(value)) {
            throw policyError('Customer identifier contains unsupported characters');
        }
        normalized = value.replace(/[^\d]/g, '');
    }

    if (!normalized || !normalized.trim()) throw policyError('Customer identifier is required');
    if (policy.minLength != null && normalized.length < policy.minLength) {
        throw policyError(`Customer identifier must be at least ${policy.minLength} characters`);
    }
    if (policy.maxLength != null && normalized.length > policy.maxLength) {
        throw policyError(`Customer identifier must be at most ${policy.maxLength} characters`);
    }

    const kind = policy.kind || 'text';
    if (kind === 'numeric' && !/^\d+$/.test(normalized)) {
        throw policyError('Customer identifier must contain only digits');
    }
    if (kind === 'phone' && !/^\+?\d{7,15}$/.test(normalized)) {
        throw policyError('Customer identifier must be a valid phone number');
    }
    if (kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
        throw policyError('Customer identifier must be a valid email address');
    }
    if (policy.pattern && (!isSafeIdentifierPattern(policy.pattern) || !new RegExp(policy.pattern).test(normalized))) {
        throw policyError('Customer identifier format is invalid');
    }
    return normalized;
};

const normalizeAmount = (value, purchaseMode, policy) => {
    if (purchaseMode !== 'amount') return undefined;
    if (!policy) throw policyError('Amount policy is not configured');

    const minimum = Number(policy.min);
    const maximum = Number(policy.max);
    const step = Number(policy.step);
    if (!Number.isFinite(minimum) || minimum <= 0
        || !Number.isFinite(maximum) || maximum < minimum
        || !Number.isFinite(step) || step <= 0) {
        throw policyError('Amount policy is invalid');
    }

    const amountText = String(value).trim();
    if (!/^-?\d+(?:\.\d{1,2})?$/.test(amountText)) {
        throw policyError('Amount cannot have more than two decimal places');
    }
    const amount = Number(amountText);
    if (!Number.isFinite(amount)) throw policyError('A valid amount is required');
    if (amount < minimum || amount > maximum) {
        throw policyError(`Amount must be between ${minimum} and ${maximum}`);
    }

    const scale = 100;
    const amountMinor = Math.round(amount * scale);
    const minMinor = Math.round(minimum * scale);
    const stepMinor = Math.round(step * scale);
    if (stepMinor <= 0 || (amountMinor - minMinor) % stepMinor !== 0) {
        throw policyError(`Amount must increase in steps of ${step}`);
    }
    if ((policy.currency || 'NGN') !== 'NGN') {
        throw policyError('Only NGN Broadband purchases are currently supported');
    }
    return amount;
};

const maskIdentifier = value => {
    const text = String(value || '');
    if (text.length <= 4) return '*'.repeat(text.length);
    return `${'*'.repeat(Math.min(8, text.length - 4))}${text.slice(-4)}`;
};

module.exports = { isSafeIdentifierPattern, normalizeIdentifier, normalizeAmount, maskIdentifier };
