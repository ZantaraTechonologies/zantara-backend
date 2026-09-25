const { encryptSecret, decryptSecret, isEncrypted } = require('./crypto');

const CREDENTIAL_KEYS = new Set([
    'token',
    'tokens',
    'pin',
    'pins',
    'purchased_code',
    'purchasedcode',
    'main_token',
    'maintoken',
    'token_code',
    'serial',
    'serials',
    'serial_number',
    'serial_no',
    'serialnumber',
    'card_serial',
    'fulfillment',
]);

function cleanCredential(value, labelPattern) {
    if (value === undefined || value === null) return null;
    const cleaned = String(value)
        .replace(/[\r\n\t]+/g, ' ')
        .replace(labelPattern, '')
        .trim();
    return cleaned || null;
}

function normalizeItem(value, fallbackSerial = null, allowGenericCode = true) {
    if (value === undefined || value === null) return null;

    if (typeof value !== 'object') {
        const text = String(value).trim();
        const codeMatch = text.match(/(?:^|[,;|\r\n])\s*(?:pin|token|code)\s*:\s*([^,;|\r\n]+)/i);
        const serialMatch = text.match(/(?:^|[,;|\r\n])\s*serial(?:\s*(?:number|no\.?))?\s*:\s*([^,;|\r\n]+)/i);
        const hasLabels = Boolean(codeMatch || serialMatch);
        const code = cleanCredential(codeMatch ? codeMatch[1] : (hasLabels ? null : value), /^(?:token|pin|code)\s*:\s*/i);
        const serial = cleanCredential(serialMatch ? serialMatch[1] : fallbackSerial, /^serial(?:\s*(?:number|no\.?))?\s*:\s*/i);
        return code ? { code, serial } : null;
    }

    if (value.purchased_code !== undefined || value.purchasedCode !== undefined) {
        const suppliedSerial = value.serial
            ?? value.Serial
            ?? value.serial_number
            ?? value.serial_no
            ?? value.serialNumber
            ?? value.SerialNumber
            ?? fallbackSerial;
        return normalizeItem(value.purchased_code ?? value.purchasedCode, suppliedSerial, allowGenericCode);
    }

    const codeValue = value.token
        ?? value.pin
        ?? value.Pin
        ?? value.PIN
        ?? value.token_code
        ?? value.mainToken
        ?? value.main_token
        ?? (allowGenericCode ? value.code : undefined);
    const serialValue = value.serial
        ?? value.Serial
        ?? value.serial_number
        ?? value.serial_no
        ?? value.serialNumber
        ?? value.SerialNumber
        ?? value.serialNo
        ?? value.card_serial
        ?? fallbackSerial;
    const code = cleanCredential(codeValue, /^(?:token|pin|code)\s*:\s*/i);
    const serial = cleanCredential(serialValue, /^serial(?:\s*(?:number|no\.?))?\s*:\s*/i);
    return code ? { code, serial } : null;
}

function normalizeArray(values, serials) {
    if (!Array.isArray(values)) return [];
    return values
        .map((value, index) => normalizeItem(value, Array.isArray(serials) ? serials[index] : null))
        .filter(Boolean);
}

function normalizeFulfillment(source) {
    if (!source || typeof source !== 'object') return { items: [] };

    const explicitItems = Array.isArray(source.items)
        ? normalizeArray(source.items)
        : source.fulfillment && Array.isArray(source.fulfillment.items)
            ? normalizeArray(source.fulfillment.items)
            : [];
    if (explicitItems.length > 0) return { items: explicitItems };

    const arrayCandidates = [
        [source.tokens, source.serials],
        [source.pins, source.serials],
        [source.codes, source.serials],
        [source.cards, source.serials],
        [Array.isArray(source.purchased_code) ? source.purchased_code : null, source.serials],
        [source.data?.tokens, source.data?.serials],
        [source.data?.pins, source.data?.serials],
        [source.data?.cards, source.data?.serials],
        [Array.isArray(source.data?.purchased_code) ? source.data.purchased_code : null, source.data?.serials],
        [source.content?.tokens, source.content?.serials],
        [source.content?.pins, source.content?.serials],
        [source.content?.cards, source.content?.serials],
    ];
    for (const [values, serials] of arrayCandidates) {
        const items = normalizeArray(values, serials);
        if (items.length > 0) return { items };
    }

    const transactions = source.content?.transactions;
    if (Array.isArray(transactions)) {
        const items = transactions.map(item => normalizeItem(item, null, false)).filter(Boolean);
        if (items.length > 0) return { items };
    } else if (transactions && typeof transactions === 'object') {
        const item = normalizeItem(transactions, null, false);
        if (item) return { items: [item] };
    }

    const singularCandidates = [
        source,
        source.data,
        source.content,
    ];
    for (const candidate of singularCandidates) {
        const item = normalizeItem(candidate, null, false);
        if (item) return { items: [item] };
    }

    return { items: [] };
}

function encryptFulfillment(fulfillment, { expectedQuantity = 0, complete = false } = {}) {
    const items = normalizeFulfillment(fulfillment).items.map(item => ({
        code: encryptSecret(item.code),
        serial: item.serial ? encryptSecret(item.serial) : null,
    }));
    return {
        items,
        expectedQuantity,
        itemCount: items.length,
        complete: Boolean(complete),
    };
}

function decryptFulfillment(fulfillment) {
    if (!fulfillment || !Array.isArray(fulfillment.items)) {
        return { items: [], expectedQuantity: 0, itemCount: 0, complete: false };
    }
    const items = fulfillment.items
        .map(item => {
            const decryptedCode = decryptSecret(item.code);
            const decryptedSerial = decryptSecret(item.serial);
            const code = isEncrypted(decryptedCode)
                ? null
                : cleanCredential(decryptedCode, /^(?:token|pin|code)\s*:\s*/i);
            const serial = isEncrypted(decryptedSerial)
                ? null
                : cleanCredential(decryptedSerial, /^serial(?:\s*(?:number|no\.?))?\s*:\s*/i);
            return code ? { code, serial } : null;
        })
        .filter(Boolean);
    return {
        items,
        expectedQuantity: Number(fulfillment.expectedQuantity) || 0,
        itemCount: items.length,
        complete: Boolean(fulfillment.complete),
    };
}

function redactProviderEvidence(value, fulfillment) {
    const secrets = normalizeFulfillment(fulfillment).items
        .flatMap(item => [item.code, item.serial])
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);

    const redact = (input, key = '') => {
        if (CREDENTIAL_KEYS.has(String(key).toLowerCase())) return '[REDACTED]';
        if (Array.isArray(input)) return input.map(item => redact(item));
        if (input && typeof input === 'object') {
            const output = {};
            for (const [childKey, childValue] of Object.entries(input)) {
                output[childKey] = redact(childValue, childKey);
            }
            return output;
        }
        if (input === undefined || input === null) return input;
        const text = String(input);
        if (!secrets.some(secret => text.includes(secret))) return input;
        return secrets.reduce(
            (redacted, secret) => redacted.split(secret).join('[REDACTED]'),
            text
        );
    };

    return redact(value);
}

function expectedFulfillmentQuantity(transaction) {
    if (!transaction) return 0;
    if (transaction.type === 'pin') {
        const quantity = Number(transaction.details?.quantity);
        return Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
    }
    if (transaction.type === 'electricity') {
        const meterType = String(transaction.details?.meter_type || transaction.details?.variation_code || '').toLowerCase();
        return meterType.includes('prepaid') ? 1 : 0;
    }
    return 0;
}

module.exports = {
    normalizeFulfillment,
    encryptFulfillment,
    decryptFulfillment,
    redactProviderEvidence,
    expectedFulfillmentQuantity,
};
