/**
 * PIN quantity parsing for exam-card (category 'pin') purchases.
 *
 * A PIN is a fixed-cost per-card unit. This module validates the batch size.
 *
 * CONTRACT:
 *   - omitted|null|undefined|''  -> treated as ABSENT (see callers; the
 *     purchase/pricing boundary defaults an absent quantity to 1 to preserve
 *     the historical `quantity ? Number(quantity) : 1` behaviour).
 *   - valid                       -> a positive integer (1, 2, 5, 10, ...).
 *   - explicitly malformed        -> a POSITIVE integer >= 1:
 *       0, -1, 1.5, "abc", Infinity-equivalent -> null (rejected for strict
 *       callers, resolved to 1 for lenient/preview callers).
 *
 * No arbitrary business maximum is imposed: research across backend config,
 * models, routes, provider integrations (VTPass / Vas2Nets / universal) and
 * the UI found NO authoritative (non-UI) upper bound. UI-only caps exist
 * (web max 10, mobile max 5) but are not server business rules.
 *
 * A configurable maximum quantity remains a FUTURE product/abuse-control
 * decision and is intentionally not part of this batch.
 */
function normalizePinQuantity(rawQuantity) {
    if (rawQuantity === undefined || rawQuantity === null || rawQuantity === '') return null;

    const value = Number(rawQuantity);
    if (!Number.isFinite(value)) return null;
    if (!Number.isInteger(value)) return null;
    if (value < 1) return null;

    return value;
}

/**
 * Lenient boundary (pricing preview / engine internals): absent or invalid
 * resolves to 1. Explicit malformed values fall back to 1 so a bogus batch
 * can never inflate the authoritative totals.
 *
 * @returns {number} - positive integer (1 when absent or invalid).
 */
function resolvePinQuantity(rawQuantity) {
    const normalized = normalizePinQuantity(rawQuantity);
    return normalized === null ? 1 : normalized;
}

/**
 * Strict boundary (POST /purchase-pin): absent quantity is allowed and
 * treated as 1 (historical API compatibility); explicitly malformed
 * quantities are rejected before any debit or provider call.
 *
 * @returns {{ ok: boolean, quantity?: number, message?: string }}
 */
function validatePinQuantity(rawQuantity) {
    if (rawQuantity === undefined || rawQuantity === null || rawQuantity === '') {
        return { ok: true, quantity: 1 };
    }

    const normalized = normalizePinQuantity(rawQuantity);
    if (normalized === null) {
        return {
            ok: false,
            message: 'Quantity must be a whole number that is 1 or greater',
        };
    }
    return { ok: true, quantity: normalized };
}

module.exports = {
    normalizePinQuantity,
    resolvePinQuantity,
    validatePinQuantity,
};