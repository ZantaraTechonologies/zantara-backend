'use strict';

const STRICT_DECIMAL = /^\d+(?:\.\d{1,2})?$/;
const STRICT_INTEGER = /^\d+$/;

function parseInvestmentMoney(value, { allowZero = false, label = 'Amount' } = {}) {
    if (typeof value !== 'number' && typeof value !== 'string') {
        throw new Error(`${label} must be a number`);
    }
    if (typeof value === 'string') {
        if (!value || value !== value.trim() || !STRICT_DECIMAL.test(value)) {
            throw new Error(`${label} must be a strict decimal value with at most two decimal places`);
        }
    }

    const number = typeof value === 'number' ? value : Number(value);
    const rawKobo = number * 100;
    const kobo = Math.round(rawKobo);
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(rawKobo)) * 4;
    if (!Number.isFinite(number) || !Number.isSafeInteger(kobo) || Math.abs(rawKobo - kobo) > tolerance) {
        throw new Error(`${label} must convert exactly to safe integer kobo`);
    }
    if (allowZero ? kobo < 0 : kobo <= 0) {
        throw new Error(`${label} must be ${allowZero ? 'non-negative' : 'greater than zero'}`);
    }

    return { kobo, naira: kobo / 100 };
}

function parseShareQuantity(value, label = 'Quantity') {
    if (typeof value !== 'number' && typeof value !== 'string') {
        throw new Error(`${label} must be a positive integer`);
    }
    if (typeof value === 'string') {
        if (!value || value !== value.trim() || !STRICT_INTEGER.test(value)) {
            throw new Error(`${label} must be a positive integer`);
        }
    }
    const quantity = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return quantity;
}

function parsePercentage(value, { label = 'Percentage', allowHundred = false } = {}) {
    const parsed = parseInvestmentMoney(value, { allowZero: true, label }).naira;
    if (parsed > 100 || (!allowHundred && parsed === 100)) {
        throw new Error(`${label} is outside the supported range`);
    }
    return parsed;
}

module.exports = { parseInvestmentMoney, parseShareQuantity, parsePercentage };
