const Notification = require('../models/Notification');
const User = require('../models/User');
const { sendEmail } = require('../utils/mailer');
const { sendSMS } = require('../utils/sms');
const { getNotificationBrand } = require('../utils/notificationBrand');
const {
    buildFundingSuccessContent,
    buildEmailShell,
    buildPurchaseSuccessContent,
    buildPurchaseFailureContent,
    formatNairaAmount,
    safeTransactionReference,
} = require('../utils/notificationFormatter');
const https = require('https');
const { maskSecret, sanitizeText } = require('../utils/logSanitizer');

class NotificationService {
    /**
     * Send an Expo Push Notification to a device
     */
    async sendPush(pushToken, { title, body, data = {}, priority = 'default' }) {
        if (!pushToken || !pushToken.startsWith('ExponentPushToken')) {
            console.warn(`[Push] Invalid or missing token: ${maskSecret(pushToken)}`);
            return;
        }

        const payload = JSON.stringify({
            to: pushToken,
            sound: 'default',
            title,
            body,
            data,
            priority,
        });

        console.log(`[Push] Attempting send to ${maskSecret(pushToken)} (Title: ${title})`);

        return new Promise((resolve) => {
            const req = https.request({
                hostname: 'exp.host',
                path: '/--/api/v2/push/send',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Accept-Encoding': 'gzip, deflate',
                }
            }, (res) => {
                let chunks = '';
                res.on('data', (c) => chunks += c);
                res.on('end', () => {
                    try {
                        const response = JSON.parse(chunks);
                        if (response.errors) {
                            console.error('[Push Error] Expo API returned errors:', sanitizeText(JSON.stringify(response.errors), [pushToken]));
                        } else {
                            console.log('[Push Success] Expo Response:', sanitizeText(JSON.stringify(response.data), [pushToken]));
                        }
                        resolve(response);
                    } catch (e) {
                        console.log(`[Push] Raw Response: ${sanitizeText(chunks, [pushToken])}`);
                        resolve(chunks);
                    }
                });
            });
            req.on('error', (e) => {
                console.error('[Push] Network Error (Possible Render Timeout):', e.message);
                resolve(null);
            });
            req.write(payload);
            req.end();
        });
    }

    /**
     * Fire-and-forget push for a user (best effort, never throws).
     */
    _pushToUser(userId, { title, body, data = {}, priority = 'default' }) {
        User.findById(userId).select('pushToken').lean().then(user => {
            if (user?.pushToken) {
                this.sendPush(user.pushToken, { title, body, data, priority }).catch(() => {});
            } else {
                console.warn(`[Push] No token found for user ${userId}`);
            }
        }).catch((err) => {
            console.error(`[Push] Token lookup failed for ${userId}:`, err.message);
        });
    }

    /**
     * Atomically creates the in-app Notification — or safely no-ops on a
     * duplicate eventKey (sparse unique index).
     *
     * Orchestration dedup gate: callers that need cross-channel dedup must
     * only fan out push/email/SMS AFTER this method returns truthy.
     *
     * Returns the created Notification document, or null when the event was
     * already delivered (or creation failed without throwing).
     */
    async _createEventDeduped({ userId, eventKey, title, message, type, metadata }) {
        if (!eventKey) {
            try {
                return await Notification.create({ userId, title, message, type, metadata });
            } catch (err) {
                console.error('In-app notification error:', err && err.message);
                return null;
            }
        }

        const existing = await Notification.findOne({ userId, eventKey }).lean().catch(() => null);
        if (existing) {
            console.log(`[Notification Dedupe] event '${eventKey}' already delivered. Skipping.`);
            return null;
        }

        try {
            return await Notification.create({ userId, title, message, type, metadata, eventKey });
        } catch (err) {
            if (err && err.code === 11000) {
                console.log(`[Notification Dedupe] concurrent duplicate '${eventKey}' suppressed.`);
                return null;
            }
            console.error('In-app notification error:', err && err.message);
            return null;
        }
    }

    /**
     * Send an in-app notification (optionally deduplicated by eventKey) plus a
     * fire-and-forget push if the user has a token.
     */
    async sendInApp(userId, { title, message, type, metadata }, eventKey = null) {
        try {
            if (type === 'security') {
                console.log(`[SECURITY NOTIFICATION] User: ${userId}, Title: ${title}, Message: [REDACTED]`);
            }

            const notification = await this._createEventDeduped({
                userId, eventKey, title, message, type, metadata
            });
            if (!notification) return null;

            this._pushToUser(userId, {
                title,
                body: message,
                data: { type, ...(metadata || {}) },
                priority: type === 'security' ? 'high' : 'default'
            });

            return notification;
        } catch (err) {
            console.error('In-app notification error:', err.message);
            return null;
        }
    }

    /**
     * Send an email notification (Wrapper for existing mailer)
     */
    async sendEmail(to, subject, html, activityType = null) {
        try {
            await sendEmail(to, subject, html, activityType);
        } catch (err) {
            console.error('Email notification error:', err.message);
        }
    }

    /**
     * Send an SMS notification (Wrapper for existing SMS utility)
     */
    async sendSMS(phone, message, activityType = null) {
        try {
            await sendSMS(phone, message, activityType);
        } catch (err) {
            console.error('SMS notification error:', err.message);
        }
    }

    /**
     * Notify a user via in-app, push, email and SMS.
     *
     * PERFORMANCE CONTRACT:
     *   - In-app notification is persisted to DB before this method returns.
     *   - Email and SMS are dispatched asynchronously (fire-and-forget).
     *   - One failing channel never blocks or fails another channel.
     *   - Callers receive control back as soon as the DB write finishes
     *     (~10 ms), regardless of SMTP/SMS/push delivery time.
     *
     * DEDUPLICATION CONTRACT:
     *   - When `eventKey` is provided, the in-app write becomes the
     *     orchestration dedup gate: if the event was already delivered, ALL
     *     channels (in-app, push, email, SMS) are skipped and
     *     `{ deduplicated: true }` is returned.
     *   - Without `eventKey`, behavior is byte-for-byte identical to the
     *     legacy path.
     */
    async notify(user, { title, message, type, metadata, emailHtml, emailSubject, smsMessage, activityType, eventKey }) {
        // 1. In-App + Push. The in-app write is the dedup gate for eventKey'd
        //    events; push is always fire-and-forget inside sendInApp().
        let createdHeader = true;
        if (eventKey) {
            const notif = await this.sendInApp(user._id, { title, message, type, metadata }, eventKey);
            createdHeader = !!notif;
        } else {
            await this.sendInApp(user._id, { title, message, type, metadata });
        }

        // Already delivered through every channel — safe no-op.
        if (!createdHeader) {
            return { deduplicated: true };
        }

        // 2. Email — fire-and-forget. DNS + SMTP can take 2-10 s.
        if (user.email && emailHtml) {
            this.sendEmail(user.email, emailSubject || title, emailHtml, activityType)
                .catch(err => console.error('[Notification] Email delivery error:', err.message));
        }

        // 3. SMS — fire-and-forget. Termii HTTP call can take 1-5 s.
        if (user.phone && smsMessage) {
            this.sendSMS(user.phone, smsMessage, activityType)
                .catch(err => console.error('[Notification] SMS delivery error:', err.message));
        }
        // notify() returns here — immediately after in-app write, without
        // waiting for email or SMS to complete.
    }

    /**
     * Wallet-funding SUCCESS notification (In-App + Push + Email; no SMS).
     *
     * SAFETY CONTRACT:
     *   - `amount` is the already-authoritative credited amount.
     *   - `method` MUST be a customer-facing funding method (never a gateway).
     *   - Email failure is fully isolated: it never fails funding, reverses a
     *     credit, or changes TransactionStatus.
     *   - Deduplicated by eventKey `funding_success:<reference>` (or
     *     `investment_buy_success:<reference>` for share purchases).
     *   - This method never throws.
     */
    async sendFundingSuccess({ userId, amount, method, reference, type = 'funding' }) {
        try {
            const brand = await getNotificationBrand();
            const isInvestment = type === 'investment_buy';

            const title = isInvestment
                ? 'Shares Purchased Successfully'
                : 'Wallet Funded Successfully';
            const message = isInvestment
                ? 'Your purchase of platform shares has been confirmed. Welcome aboard!'
                : buildFundingSuccessContent({ amount, method, reference, brand }).message;
            const emailHtml = isInvestment ? null : buildFundingSuccessContent({ amount, method, reference, brand }).emailHtml;
            const emailSubject = isInvestment ? null : 'Wallet Funded Successfully';

            // Intrinsic event identity — a returned/concurrent duplicate is a no-op.
            const eventKey = isInvestment
                ? `investment_buy_success:${reference}`
                : `funding_success:${reference}`;

            const notif = await this.sendInApp(userId, {
                title,
                message,
                type: 'transaction',
                metadata: { reference }
            }, eventKey);

            if (!notif) return { deduplicated: true };

            // Email is the ONLY additional funding channel. No SMS for funding.
            if (!isInvestment && emailHtml) {
                const user = await User.findById(userId).select('email').lean();
                if (user && user.email) {
                    this.sendEmail(user.email, emailSubject, emailHtml, 'funding_success')
                        .catch(err => console.error('[Funding Email] delivery error:', err && err.message));
                }
            }

            return { dispatched: true };
        } catch (err) {
            console.error('[Funding Notification Background Error]', err && err.message);
            return { dispatched: false };
        }
    }

    /**
     * Purchase SUCCESS notification built from the approved formatter.
     *
     * SAFETY / COMPATIBILITY CONTRACT:
     *   - Uses the module-level `notify()` so existing tests and callers that
     *     stub `notificationService.notify` keep intercepting effortlessly.
     *     Rejections propagate to the caller's fire-and-forget `.catch()` so a
     *     failing notification background log is still produced (and a failed
     *     notification can never fail the purchase itself, since callers do
     *     not await this).
     *   - Deduplicated by eventKey `purchase_success:<reference>`.
     *   - Raw provider/service codes are never surfaced (formatter contract).
     */
    async notifyPurchaseSuccess(user, { type, serviceId, amount, reference, details, greetingName }) {
        const brand = await getNotificationBrand();
        const at = new Date();
        const content = buildPurchaseSuccessContent({
            type,
            serviceId,
            amount,
            reference,
            details,
            brand,
            greetingName,
            at
        });

        return await this.notify(user, {
            title: content.title,
            message: content.message,
            smsMessage: content.smsMessage,
            emailSubject: content.emailSubject,
            emailHtml: content.emailHtml,
            type: 'transaction',
            activityType: 'purchase_success',
            metadata: { transactionId: reference },
            eventKey: `purchase_success:${safeTransactionReference(reference)}`
        });
    }

    /**
     * Purchase FAILURE notification built from the approved formatter.
     *
     * SAFETY CONTRACT:
     *   - `refunded` MUST only be true when the caller has already proven the
     *     reversal completed (the builder claims a refund only then).
     *   - `reason` is sanitized — raw err.message / provider exception text
     *     never reaches the customer.
     *   - Rejections propagate to the caller's fire-and-forget `.catch()`.
     *   - Deduplicated by eventKey `purchase_failed:<reference>`.
     */
    async notifyPurchaseFailure(user, { type, serviceId, amount, reference, reason, refunded, greetingName }) {
        const brand = await getNotificationBrand();
        const at = new Date();
        const content = buildPurchaseFailureContent({
            type,
            serviceId,
            amount,
            reference,
            reason,
            refunded,
            brand,
            greetingName,
            at
        });

        return await this.notify(user, {
            title: content.title,
            message: content.message,
            smsMessage: content.smsMessage,
            emailSubject: content.emailSubject,
            emailHtml: content.emailHtml,
            type: 'transaction',
            activityType: 'purchase_failed',
            metadata: { transactionId: reference },
            eventKey: `purchase_failed:${safeTransactionReference(reference)}`
        });
    }

    /**
     * Dispatch a referral-commission-eared notification AFTER the enclosing
     * parent purchase has committed. `intent` is produced by referral
     * processing and carries only safe, customer-facing data.
     * Never throws.
     */
    async notifyReferralEarned({ userId, email, phone, buyerLabel, service, commission, eventKey, commId }) {
        try {
            const brand = await getNotificationBrand();
            const amountLine = formatNairaAmount(commission);
            const title = 'Referral Commission Earned';
            const message = `You earned ${amountLine} from ${buyerLabel}'s ${service} purchase.`;

            const emailHtml = buildEmailShell(brand, {
                title,
                bodyHtml: `<p>Hello,</p><p>You earned <b>${amountLine}</b> in referral commission from ${buyerLabel}'s <b>${service}</b> purchase.</p>`
            });

            return await this.notify(
                { _id: userId, email, phone },
                {
                    title,
                    message,
                    emailHtml,
                    emailSubject: title,
                    smsMessage: `You earned ${amountLine} in referral commission.`,
                    type: 'referral',
                    activityType: 'referral_commission',
                    metadata: { transactionId: commId },
                    eventKey
                }
            );
        } catch (err) {
            console.error('[Referral Notification Background Error]', err && err.message);
            return { dispatched: false };
        }
    }

    /**
     * Funding failure / reconciliation advisory (In-App + Push only; never SMS,
     * never email, never claims credited/refunded/failed unless authoritative).
     * Deduplicated by eventKey so repeated verification requests cannot spam.
     * Never throws.
     */
    async sendFundingAdvisory(userId, { kind, amount, reference }) {
        try {
            const amountLine = formatNairaAmount(amount);
            const isFailed = kind === 'failed';
            const eventKey = isFailed
                ? `funding_failed:${reference}`
                : `funding_review:${reference}`;
            const title = isFailed ? 'Wallet Funding Unsuccessful' : 'Wallet Funding Under Review';
            const message = isFailed
                ? `Your wallet funding of ${amountLine} (Reference: ${reference}) could not be completed.`
                : `Your wallet funding of ${amountLine} (Reference: ${reference}) is being verified. We will update you once it is resolved.`;

            const notif = await this.sendInApp(userId, {
                title,
                message,
                type: 'transaction',
                metadata: { reference }
            }, eventKey);
            return notif ? { dispatched: true } : { deduplicated: true };
        } catch (err) {
            console.error('[Funding Advisory Error]', err && err.message);
            return { dispatched: false };
        }
    }

    /**
     * Diagnostic tool to verify backend configuration without exposing full secrets
     */
    async getDiagnostics() {
        const mask = (str) => {
            if (!str || str === 'mock') return 'NOT SET';
            if (str.length < 8) return 'SET (Short)';
            return `${str.substring(0, 4)}****${str.substring(str.length - 4)}`;
        };

        return {
            push: {
                provider: 'Expo',
                host: 'exp.host'
            },
            email: {
                user: process.env.MAIL_USER || 'NOT SET',
                pass: process.env.MAIL_PASS ? 'PRESENT (Masked)' : 'MISSING',
                host: 'smtp.gmail.com'
            },
            sms: {
                provider: 'Termii',
                apiKey: mask(process.env.TERMII_API_KEY),
                senderId: process.env.TERMII_SENDER_ID || 'Zantara'
            },
            env: process.env.NODE_ENV || 'development'
        };
    }
}

module.exports = new NotificationService();