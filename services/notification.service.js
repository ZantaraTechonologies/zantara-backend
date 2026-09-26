const Notification = require('../models/Notification');
const SmsDelivery = require('../models/SmsDelivery');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { sendEmail } = require('../utils/mailer');
const { sendSMS } = require('../utils/sms');
const { getNotificationBrand } = require('../utils/notificationBrand');
const {
    buildFundingSuccessContent,
    buildEmailShell,
    buildPurchaseSuccessContent,
    buildPurchaseFailureContent,
    buildCredentialSmsBatches,
    formatNairaAmount,
    safeTransactionReference,
} = require('../utils/notificationFormatter');
const { decryptFulfillment } = require('../utils/fulfillment');
const https = require('https');
const { maskSecret, sanitizeText } = require('../utils/logSanitizer');

const SMS_MAX_ATTEMPTS = 3;
const SMS_STALE_AFTER_MS = 5 * 60 * 1000;
const SMS_RECOVERY_BATCH_SIZE = 100;

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
            return await sendSMS(phone, message, activityType);
        } catch (err) {
            console.error('SMS notification error:', err.message);
            return { success: false };
        }
    }

    async _claimCredentialSmsBatch({ userId, eventKey, reference, batchIndex, brandName = null, staleOnly = false, staleBefore = null }) {
        const cutoff = staleBefore || new Date(Date.now() - SMS_STALE_AFTER_MS);
        const retryState = staleOnly
            ? { status: 'dispatching', updatedAt: { $lt: cutoff } }
            : {
                $or: [
                    { status: 'failed' },
                    { status: 'dispatching', updatedAt: { $lt: cutoff } },
                ],
            };
        const delivery = await SmsDelivery.findOneAndUpdate({
            userId,
            eventKey,
            attempts: { $lt: SMS_MAX_ATTEMPTS },
            ...retryState,
        }, {
            $set: { status: 'dispatching', updatedAt: new Date() },
            $inc: { attempts: 1 },
        }, { new: true });
        if (delivery || staleOnly) return delivery;

        try {
            return await SmsDelivery.create({
                userId,
                eventKey,
                reference: safeTransactionReference(reference),
                batchIndex,
                brandName: brandName ? String(brandName) : null,
                attempts: 1,
                status: 'dispatching',
            });
        } catch (error) {
            if (error?.code === 11000) return null;
            throw error;
        }
    }

    async _sendClaimedCredentialSmsBatch({ delivery, user, message, messages, activityType, eventKey, reference, brandName }) {
        let result;
        try {
            result = await this.sendSMS(user.phone, message, activityType);
        } catch (_) {
            result = { success: false };
        }
        const failed = result?.success === false || result?.delivered === false;
        const completion = await SmsDelivery.updateOne({
            _id: delivery._id,
            status: 'dispatching',
            attempts: delivery.attempts,
        }, {
            $set: { status: failed ? 'failed' : 'delivered' },
        }).catch(() => ({ modifiedCount: 0 }));

        if (completion.modifiedCount !== 1) return false;
        if (failed && Number(delivery.attempts) < SMS_MAX_ATTEMPTS) {
            const retry = setTimeout(() => {
                this._dispatchCredentialSmsBatches(user, messages, activityType, eventKey, reference, brandName)
                    .catch(() => {});
            }, 30000);
            if (typeof retry.unref === 'function') retry.unref();
        }
        return !failed;
    }

    async _dispatchCredentialSmsBatches(user, messages, activityType, eventKey, reference, brandName = null) {
        for (let index = 0; index < messages.length; index++) {
            const batchIndex = index + 1;
            const batchKey = `${eventKey}:sms:${batchIndex}`;
            let delivery;
            try {
                delivery = await this._claimCredentialSmsBatch({
                    userId: user._id,
                    eventKey: batchKey,
                    reference,
                    batchIndex,
                    brandName,
                });
            } catch (_) {
                console.error(`[Notification] Credential SMS batch dispatch failed (${batchKey}).`);
                return false;
            }

            if (!delivery) {
                const existing = await SmsDelivery.findOne({ userId: user._id, eventKey: batchKey }).catch(() => null);
                if (existing?.status === 'delivered') continue;
                return false;
            }

            const delivered = await this._sendClaimedCredentialSmsBatch({
                delivery,
                user,
                message: messages[index],
                messages,
                activityType,
                eventKey,
                reference,
                brandName,
            });
            if (!delivered) return false;
        }
        return true;
    }

    async _recoverStaleCredentialSmsDelivery(candidate, staleBefore) {
        const rejectCandidate = async () => {
            await SmsDelivery.updateOne({
                _id: candidate._id,
                status: 'dispatching',
                attempts: candidate.attempts,
                updatedAt: { $lt: staleBefore },
            }, {
                $set: { status: 'failed' },
            }).catch(() => {});
            return false;
        };
        const transaction = await Transaction.findOne({
            userId: candidate.userId,
            $or: [
                { transactionId: candidate.reference },
                { refId: candidate.reference },
            ],
            status: 'success',
            isLoss: false,
        });
        if (!transaction) return rejectCandidate();

        const reference = safeTransactionReference(
            transaction.providerRequestId ? transaction.transactionId : transaction.refId
        );
        const eventKey = `purchase_success:${reference}`;
        if (candidate.eventKey !== `${eventKey}:sms:${candidate.batchIndex}`) return rejectCandidate();

        if (candidate.batchIndex > 1) {
            const previous = await SmsDelivery.findOne({
                userId: candidate.userId,
                eventKey: `${eventKey}:sms:${candidate.batchIndex - 1}`,
            });
            if (previous?.status !== 'delivered') return rejectCandidate();
        }

        const fulfillment = decryptFulfillment(transaction.fulfillment);
        const storedItemCount = Number(transaction.fulfillment?.itemCount) || 0;
        if (!fulfillment.complete || fulfillment.items.length === 0 || fulfillment.items.length !== storedItemCount) {
            return rejectCandidate();
        }
        const user = await User.findById(candidate.userId);
        if (!user?.phone) return rejectCandidate();
        const brand = candidate.brandName
            ? { siteName: candidate.brandName }
            : await getNotificationBrand();
        const messages = buildCredentialSmsBatches({
            type: transaction.type,
            serviceId: transaction.service,
            reference,
            details: transaction.details,
            fulfillment,
            brand,
        });
        const message = messages[candidate.batchIndex - 1];
        if (!message) return rejectCandidate();

        const delivery = await this._claimCredentialSmsBatch({
            userId: candidate.userId,
            eventKey: candidate.eventKey,
            reference,
            batchIndex: candidate.batchIndex,
            brandName: brand.siteName,
            staleOnly: true,
            staleBefore,
        });
        if (!delivery) return false;

        const delivered = await this._sendClaimedCredentialSmsBatch({
            delivery,
            user,
            message,
            messages,
            activityType: 'purchase_success',
            eventKey,
            reference,
            brandName: brand.siteName,
        });
        if (!delivered) return false;

        await this._dispatchCredentialSmsBatches(
            user,
            messages,
            'purchase_success',
            eventKey,
            reference,
            brand.siteName
        );
        return true;
    }

    async recoverStaleCredentialSmsDeliveries() {
        if (this._credentialSmsRecoveryRunning) return { skipped: true, recovered: 0 };
        this._credentialSmsRecoveryRunning = true;
        const staleBefore = new Date(Date.now() - SMS_STALE_AFTER_MS);
        try {
            const candidates = await SmsDelivery.find({
                status: 'dispatching',
                attempts: { $lt: SMS_MAX_ATTEMPTS },
                updatedAt: { $lt: staleBefore },
            }).sort({ reference: 1, batchIndex: 1 }).limit(SMS_RECOVERY_BATCH_SIZE);
            let recovered = 0;
            for (const candidate of candidates) {
                try {
                    if (await this._recoverStaleCredentialSmsDelivery(candidate, staleBefore)) recovered++;
                } catch (_) {
                    console.error('[SMS-RECOVERY] Stale credential SMS recovery failed.');
                }
            }
            return { skipped: false, recovered };
        } finally {
            this._credentialSmsRecoveryRunning = false;
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
    async notify(user, { title, message, type, metadata, emailHtml, emailSubject, smsMessage, smsMessages, smsBrandName, activityType, eventKey }) {
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
            if (user.phone && Array.isArray(smsMessages) && smsMessages.length > 0 && eventKey) {
                const existingEvent = await Notification.findOne({ userId: user._id, eventKey }).lean().catch(() => null);
                if (existingEvent) {
                    this._dispatchCredentialSmsBatches(
                        user,
                        smsMessages,
                        activityType,
                        eventKey,
                        metadata?.transactionId,
                        smsBrandName
                    )
                        .catch(() => {});
                }
            }
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
        if (user.phone && Array.isArray(smsMessages) && smsMessages.length > 0 && eventKey) {
            this._dispatchCredentialSmsBatches(
                user,
                smsMessages,
                activityType,
                eventKey,
                metadata?.transactionId,
                smsBrandName
            )
                .catch(() => {});
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
    async notifyPurchaseSuccess(user, { type, serviceId, amount, reference, details, fulfillment, greetingName }) {
        const brand = await getNotificationBrand();
        const safeReference = safeTransactionReference(reference);
        const hasCredentialFulfillment = fulfillment?.complete
            && Array.isArray(fulfillment.items)
            && fulfillment.items.length > 0;
        const existingBatch = hasCredentialFulfillment
            ? await SmsDelivery.findOne({
                userId: user._id,
                eventKey: `purchase_success:${safeReference}:sms:1`,
            }).catch(() => null)
            : null;
        const credentialBrand = existingBatch?.brandName
            ? { ...brand, siteName: existingBatch.brandName }
            : brand;
        const at = new Date();
        const content = buildPurchaseSuccessContent({
            type,
            serviceId,
            amount,
            reference,
            details,
            fulfillment,
            brand,
            greetingName,
            at
        });
        content.smsMessages = buildCredentialSmsBatches({
            type,
            serviceId,
            reference,
            details,
            fulfillment,
            brand: credentialBrand,
        });

        return await this.notify(user, {
            title: content.title,
            message: content.message,
            smsMessage: content.smsMessage,
            smsMessages: content.smsMessages,
            smsBrandName: credentialBrand.siteName,
            emailSubject: content.emailSubject,
            emailHtml: content.emailHtml,
            type: 'transaction',
            activityType: 'purchase_success',
            metadata: { transactionId: reference },
            eventKey: `purchase_success:${safeReference}`
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
