/**
 * Customer-facing Transaction Notification Formatters
 *
 * Single source of truth for professional, safe notification copy that is
 * sent to customers. These helpers are intentionally pure (no DB access) so
 * they can be unit-tested in isolation.
 *
 * SAFETY CONTRACT:
 * - Raw provider/gateway names, internal service codes and accounting fields
 *   are NEVER surfaced here.
 * - Customer identifiers (phone / meter / billers code) are masked.
 * - Failure reasons are sanitized: raw err.message / provider exception text
 *   is replaced by safe controlled wording.
 * - All monetary values are formatted in Naira (₦nn,xxx.xx).
 * - All timestamps are rendered in Africa/Lagos (WAT) regardless of server
 *   timezone (no manual UTC+1 arithmetic).
 */

const { DateTime } = require('luxon');

// ─────────────────────────────────────────────────────────────
// AMOUNT & TIME
// ─────────────────────────────────────────────────────────────

/**
 * Formats a numeric amount as Naira: ₦200.00, ₦1,500.00, ₦10,000.50.
 * Never throws.
 */
function formatNairaAmount(amount) {
    const n = Number(amount);
    if (!Number.isFinite(n)) return '₦0.00';
    const negative = n < 0;
    const abs = Math.abs(n);
    const [intPart, decPart] = abs.toFixed(2).split('.');
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `₦${negative ? '-' : ''}${grouped}.${decPart}`;
}

/**
 * Formats a Date as a WAT (Africa/Lagos) timestamp, e.g.
 * "15 Sep 2026, 6:30 PM WAT". Timezone is derived from the IANA zone, so the
 * rendered instant is identical regardless of the server process timezone.
 * Never throws.
 */
function formatNotificationDateTimeWAT(date) {
    const input = date instanceof Date ? date : new Date(date);
    const dt = DateTime.fromJSDate(Number.isNaN(input.getTime()) ? new Date() : input)
        .setZone('Africa/Lagos');
    return `${dt.toFormat('d LLL yyyy, h:mm a')} WAT`;
}

// ─────────────────────────────────────────────────────────────
// SERVICE NAMING
// ─────────────────────────────────────────────────────────────

const TYPE_LABELS = {
    airtime: 'Airtime',
    data: 'Data Bundle',
    electricity: 'Electricity',
    cable: 'Cable TV',
    exam_pin: 'Exam PIN',
    pin: 'Exam PIN',
};

/**
 * Resolves a safe human-readable service name from an internal service code.
 * Raw internal/provider codes are never exposed. Network names and safe plan
 * labels may be included when they can be resolved reliably.
 */
function getServiceDisplayName(type, serviceId, details) {
    const raw = String(serviceId || '');
    const rawLower = raw.toLowerCase();
    const t = String(type || '').toLowerCase();

    if (details && typeof details.productName === 'string' && details.productName.trim()) {
        return details.productName.replace(/[\r\n]+/g, ' ').trim();
    }

    let network = null;
    if (details && typeof details.network === 'string' && details.network.trim()) {
        network = details.network.trim();
    }
    if (!network && rawLower) {
        if (rawLower.includes('mtn')) network = 'MTN';
        else if (rawLower.includes('glo')) network = 'GLO';
        else if (rawLower.includes('airtel')) network = 'Airtel';
        else if (rawLower.includes('9mobile') || rawLower.includes('etisalat')) network = '9mobile';
    }

    const typeLabel = TYPE_LABELS[t] || TYPE_LABELS[rawLower];

    if (network && (t === 'airtime' || t === 'data')) {
        return `${network} ${typeLabel || 'Purchase'}`;
    }
    if (typeLabel) return typeLabel;
    if (rawLower.includes('airtime')) return 'Airtime';
    if (rawLower.includes('data')) return 'Data Bundle';
    if (rawLower.includes('electricity') || rawLower.includes('power') || rawLower.includes('prepaid')) return 'Electricity';
    if (rawLower.includes('dstv') || rawLower.includes('gotv') || rawLower.includes('startimes') || rawLower.includes('cable')) return 'Cable TV';
    if (rawLower.includes('waec') || rawLower.includes('neco') || rawLower.includes('jamb') || rawLower.includes('exam') || rawLower.includes('pin')) return 'Exam PIN';
    return 'Purchase';
}

// ─────────────────────────────────────────────────────────────
// FUNDING METHOD NAMING
// ─────────────────────────────────────────────────────────────

const CHANNEL_LABELS = {
    card: 'Card',
    ussd: 'USSD',
    bank_transfer: 'Bank Transfer',
    virtual_account: 'Bank Transfer',
    bank: 'Bank Transfer',
    transfer: 'Bank Transfer',
};

/**
 * Maps an internal funding channel to a customer-facing method name.
 * Gateways (Paystack/Monnify/Flutterwave) and internal routing are never
 * exposed. Unreliable/unknown channels resolve to "Wallet Funding".
 */
function getFundingMethodDisplayName(channel) {
    const c = String(channel || '').trim().toLowerCase();
    return CHANNEL_LABELS[c] || 'Wallet Funding';
}

// ─────────────────────────────────────────────────────────────
// FAILURE REASON SANITIZATION
// ─────────────────────────────────────────────────────────────
//
// Controlled failure classes (already intentionally customer-facing) are
// allowed through verbatim. Everything else maps to the generic safe wording
// so raw err.message / provider exception text never reaches customers.

const GENERIC_FAILURE_MESSAGE = 'The transaction could not be completed. Any applicable wallet reversal has been processed.';

const SAFE_FAILURE_MARKERS = [
    'Insufficient wallet balance',
    'Transaction amount exceeds your Tier',
    'The price changed before checkout. Expected',
    'Minimum funding amount',
    'Transaction PIN has not been set',
    'Transaction PIN is required',
    'Invalid transaction PIN',
];

/**
 * Sanitizes a failure reason (Error instance, provider message or plain
 * string) into safe customer-facing wording. Never leaks technical details.
 */
function sanitizeCustomerFailureReason(input) {
    if (!input) return GENERIC_FAILURE_MESSAGE;

    const message = typeof input === 'string'
        ? input
        : (input && typeof input.message === 'string' ? input.message : '');

    // Explicit safe wording set by controlled code wins if present.
    if (input && typeof input.customerMessage === 'string' && input.customerMessage.trim()) {
        return input.customerMessage.trim();
    }

    for (const marker of SAFE_FAILURE_MARKERS) {
        if (message.includes(marker)) return message;
    }

    return GENERIC_FAILURE_MESSAGE;
}

// ─────────────────────────────────────────────────────────────
// REFERENCE & IDENTIFIER SAFETY
// ─────────────────────────────────────────────────────────────

/**
 * Returns a trimmed, display-safe transaction reference (or '').
 */
function safeTransactionReference(reference) {
    const s = String(reference || '').trim();
    return s.replace(/[\r\n]+/g, ' ');
}

/**
 * Masks a phone number for display: 08031234567 -> 080****4567.
 */
function maskPhone(phone) {
    const s = String(phone || '').trim();
    if (s.length < 8) return '****';
    return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

/**
 * Masks an account/meter/billers identifier using the same rule as maskPhone.
 */
function maskIdentifier(identifier) {
    const s = String(identifier || '').trim();
    if (s.length < 8) return '****';
    return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

// ─────────────────────────────────────────────────────────────
// EMAIL SHELL
// ─────────────────────────────────────────────────────────────

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Renders a brand-aware transactional email shell. Brand/support fields that
 * are blank are omitted. No legal entity / CAC / RC / licence wording is ever
 * injected here.
 */
function buildEmailShell(brand, { title, bodyHtml }) {
    const siteName = (brand && brand.siteName) || 'Zantara';
    const supportEmail = brand && brand.supportEmail ? String(brand.supportEmail) : '';
    const supportPhone = brand && brand.supportPhone ? String(brand.supportPhone) : '';
    const siteLogo = brand && brand.siteLogo ? String(brand.siteLogo) : '';
    const supportLine = [supportEmail, supportPhone].filter(Boolean).join(' • ');

    const logoBlock = siteLogo
        ? `<img src="${escapeHtml(siteLogo)}" alt="" style="max-width:140px;height:auto;margin-bottom:16px;" />`
        : '';

    return `
        <div style="font-family:Arial, Helvetica, sans-serif; padding:20px; max-width:560px;">
            ${logoBlock}
            <h2 style="margin:0 0 16px;">${escapeHtml(title)}</h2>
            ${bodyHtml}
            <hr style="border:none;border-top:1px solid #ececec;margin:24px 0;" />
            <p style="color:#666;font-size:12px;margin:0;">${escapeHtml(siteName)}</p>
            ${supportLine ? `<p style="color:#666;font-size:12px;margin:4px 0 0;">Support: ${escapeHtml(supportLine)}</p>` : ''}
        </div>
    `;
}

// ─────────────────────────────────────────────────────────────
// PURCHASE / FUNDING MESSAGE BUILDERS
// ─────────────────────────────────────────────────────────────

function buildContextLine(details, type) {
    if (!details || typeof details !== 'object') return '';
    switch (String(type).toLowerCase()) {
        case 'airtime':
        case 'data':
            return details.phone ? `Recipient: ${maskPhone(details.phone)}` : '';
        case 'electricity':
            return details.meter_number ? `Meter: ${maskIdentifier(details.meter_number)}` : '';
        case 'cable':
            return details.billersCode ? `Account: ${maskIdentifier(details.billersCode)}` : '';
        default:
            return '';
    }
}

function buildPlanLine(details, type) {
    if (!details || typeof details !== 'object') return '';
    if (details.variation_code) return `Plan: ${String(details.variation_code)}`;
    const t = String(type || '').toLowerCase();
    if ((t === 'exam_pin' || t === 'pin') && details.quantity) return `Quantity: ${details.quantity}`;
    return '';
}

/**
 * Builds the complete customer-facing payload for a successful purchase.
 * Returns { title, message, smsMessage, emailSubject, emailHtml }.
 */
function buildPurchaseSuccessContent({ type, serviceId, amount, reference, details, fulfillment, brand, greetingName, at }) {
    const service = getServiceDisplayName(type, serviceId, details);
    const ref = safeTransactionReference(reference);
    const when = formatNotificationDateTimeWAT(at);
    const line = buildContextLine(details, type);
    const plan = buildPlanLine(details, type);
    const amountLine = formatNairaAmount(amount);

    const message = [
        `${service} purchased successfully for ${amountLine}.`,
        line ? `${line}.` : '',
        plan ? `${plan}.` : '',
        `Reference: ${ref}.`,
        when
    ].filter(Boolean).join(' ');

    const smsMessages = buildCredentialSmsBatches({ type, serviceId, reference, details, fulfillment, brand });
    const smsMessage = smsMessages.length === 0
        ? `${service} purchase successful. ${amountLine}. Ref: ${ref}.`
        : undefined;

    const bodyParts = [
        greetingName ? `<p>Hello ${escapeHtml(greetingName)},</p>` : '',
        `<p>Your purchase of <b>${escapeHtml(service)}</b> for <b>${escapeHtml(amountLine)}</b> was successful.</p>`,
        line ? `<p>${escapeHtml(line)}.</p>` : '',
        plan ? `<p>${escapeHtml(plan)}.</p>` : '',
        `<p><b>Reference:</b> ${escapeHtml(ref)}</p>`,
        `<p>${escapeHtml(when)}</p>`
    ].filter(Boolean).join('\n');

    return {
        title: `${service} Purchase Successful`,
        message,
        smsMessage,
        smsMessages,
        emailSubject: `${service} Purchase Successful`,
        emailHtml: buildEmailShell(brand, { title: `${service} Purchase Successful`, bodyHtml: bodyParts })
    };
}

function buildCredentialSmsBatches({ type, serviceId, reference, details, fulfillment, brand, maxLength = 150 }) {
    const items = fulfillment?.complete && Array.isArray(fulfillment.items)
        ? fulfillment.items.filter(item => item && typeof item.code === 'string' && item.code.trim())
        : [];
    const normalizedType = String(type || '').toLowerCase();
    if (items.length === 0 || !['electricity', 'pin', 'exam_pin'].includes(normalizedType)) return [];

    const brandName = String(brand?.siteName || 'Zantara').replace(/[\r\n]+/g, ' ').trim() || 'Zantara';
    const service = getServiceDisplayName(type, serviceId, details);
    const ref = safeTransactionReference(reference);
    const credentialLabel = normalizedType === 'electricity' ? 'Token' : 'PIN';

    if (items.length === 1) {
        const item = items[0];
        const serial = item.serial ? ` Serial: ${item.serial}.` : '';
        return [`${brandName}: ${service} purchase successful. ${credentialLabel}: ${item.code}.${serial} Ref: ${ref}.`];
    }

    const entries = items.map((item, index) => {
        const serial = item.serial ? ` Serial: ${item.serial}.` : '';
        return `${index + 1}/${items.length} ${credentialLabel}: ${item.code}.${serial}`;
    });
    const baseHeader = `${brandName}: ${service}. Ref: ${ref}.`;
    const batches = [];
    let current = [];

    for (const entry of entries) {
        const candidate = [...current, entry].join(' ');
        if (current.length > 0 && baseHeader.length + candidate.length + 24 > maxLength) {
            batches.push(current);
            current = [entry];
        } else {
            current.push(entry);
        }
    }
    if (current.length > 0) batches.push(current);

    return batches.map((batch, index) => (
        `${brandName}: ${service} (${index + 1}/${batches.length}). Ref: ${ref}. ${batch.join(' ')}`
    ));
}

/**
 * Builds the complete customer-facing payload for an unsuccessful purchase.
 * `refunded` MUST only be true when the caller has already proven that the
 * refund/reversal completed successfully — the builder only claims a refund
 * when this flag is true.
 * Returns { title, message, smsMessage, emailSubject, emailHtml }.
 */
function buildPurchaseFailureContent({ type, serviceId, amount, reference, reason, refunded, brand, greetingName, at }) {
    const service = getServiceDisplayName(type, serviceId);
    const ref = safeTransactionReference(reference);
    const when = formatNotificationDateTimeWAT(at);
    const amountLine = formatNairaAmount(amount);
    const safeReason = sanitizeCustomerFailureReason(reason);
    const outcome = refunded
        ? 'Your wallet has been refunded.'
        : 'No charge was applied to your wallet for this attempt.';

    let message;
    if (safeReason === GENERIC_FAILURE_MESSAGE) {
        message = `${service} purchase: ${GENERIC_FAILURE_MESSAGE} ${outcome} Amount: ${amountLine}. Reference: ${ref}.`;
    } else {
        message = `${service} purchase could not be completed. ${safeReason} ${outcome} Amount: ${amountLine}. Reference: ${ref}.`;
    }

    const smsMessage = `${service} purchase was not completed. ${outcome} Ref: ${ref}.`;

    const bodyParts = [
        greetingName ? `<p>Hello ${escapeHtml(greetingName)},</p>` : '',
        `<p>Your purchase of <b>${escapeHtml(service)}</b> for <b>${escapeHtml(amountLine)}</b> could not be completed.</p>`,
        `<p>${escapeHtml(safeReason)}</p>`,
        `<p>${escapeHtml(outcome)}</p>`,
        `<p><b>Reference:</b> ${escapeHtml(ref)}</p>`,
        `<p>${escapeHtml(when)}</p>`
    ].filter(Boolean).join('\n');

    return {
        title: `${service} Purchase Unsuccessful`,
        message,
        smsMessage,
        emailSubject: `${service} Purchase Unsuccessful`,
        emailHtml: buildEmailShell(brand, { title: `${service} Purchase Unsuccessful`, bodyHtml: bodyParts })
    };
}

/**
 * Builds the customer-facing payload for a successful wallet funding.
 * `method` MUST already be a customer-facing funding method name (see
 * getFundingMethodDisplayName) — gateway names are never accepted here.
 * Returns { title, message, emailSubject, emailHtml }.
 */
function buildFundingSuccessContent({ amount, method, reference, brand, at }) {
    const ref = safeTransactionReference(reference);
    const methodLabel = getFundingMethodDisplayName(method);
    const when = formatNotificationDateTimeWAT(at);
    const amountLine = formatNairaAmount(amount);

    const message = `${amountLine} was credited to your wallet via ${methodLabel}. Reference: ${ref}. ${when}`;

    const bodyParts = [
        `<p><b>${escapeHtml(amountLine)}</b> was credited to your wallet via <b>${escapeHtml(methodLabel)}</b>.</p>`,
        `<p><b>Reference:</b> ${escapeHtml(ref)}</p>`,
        `<p>${escapeHtml(when)}</p>`
    ].join('\n');

    return {
        title: 'Wallet Funded Successfully',
        message,
        emailSubject: 'Wallet Funded Successfully',
        emailHtml: buildEmailShell(brand, { title: 'Wallet Funded Successfully', bodyHtml: bodyParts })
    };
}

module.exports = {
    formatNairaAmount,
    formatNotificationDateTimeWAT,
    getServiceDisplayName,
    getFundingMethodDisplayName,
    sanitizeCustomerFailureReason,
    safeTransactionReference,
    maskPhone,
    maskIdentifier,
    buildEmailShell,
    buildPurchaseSuccessContent,
    buildCredentialSmsBatches,
    buildPurchaseFailureContent,
    buildFundingSuccessContent,
    GENERIC_FAILURE_MESSAGE,
};
