const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

const isDuplicateKeyFor = (error, fields) => {
    if (!error || error.code !== 11000) return false;
    const expectedFields = Array.isArray(fields) ? fields : [fields];
    const reportedFields = new Set([
        ...Object.keys(error.keyPattern || {}),
        ...Object.keys(error.keyValue || {}),
    ]);

    if (reportedFields.size > 0) {
        return expectedFields.some(field => reportedFields.has(field));
    }

    const message = String(error.message || '');
    return expectedFields.some(field => {
        return hasOwn(error, field) || new RegExp(`(?:^|[\\s.{])${field}(?:_1)?(?:[\\s}:]|$)`).test(message);
    });
};

const createWithIdentifierRetry = async ({ generate, create, fields, label, maxAttempts = 3 }) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const identifiers = generate();
        try {
            return await create(identifiers);
        } catch (error) {
            if (!isDuplicateKeyFor(error, fields)) throw error;
            if (attempt === maxAttempts) {
                const exhausted = new Error(`${label} identifier generation failed after ${maxAttempts} attempts`);
                exhausted.code = 'IDENTIFIER_GENERATION_EXHAUSTED';
                exhausted.cause = error;
                throw exhausted;
            }
        }
    }
};

module.exports = { isDuplicateKeyFor, createWithIdentifierRetry };
