const axios = require('axios');
const crypto = require('crypto');
const BasePaymentAdapter = require('./base-payment.adapter');

class PaystackAdapter extends BasePaymentAdapter {
    constructor(gatewayConfig = {}) {
        super(gatewayConfig);
        this.baseUrl = (this.baseUrl || process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co').replace(/\/$/, '');
        this.secretKey = this.secretKey || process.env.PAYSTACK_SECRET_KEY || '';
        this.publicKey = this.publicKey || process.env.PAYSTACK_PUBLIC_KEY || '';
        this.webhookSecret = this.webhookSecret || this.secretKey;
    }

    async initializePayment({ user, amount, channel, reference, callbackUrl, metadata = {}, isDirectTransfer = false }) {
        if (!user || !user.email) throw new Error('PaystackAdapter: customer email is required');
        const kobo = Math.round(Number(amount) * 100);
        if (!kobo || kobo < 1) throw new Error('PaystackAdapter: invalid amount');

        const headers = {
            Authorization: `Bearer ${this.secretKey}`,
            'Content-Type': 'application/json'
        };

        if (isDirectTransfer) {
            // Paystack Charge API for dedicated transfer account
            const response = await axios.post(`${this.baseUrl}/charge`, {
                email: user.email,
                amount: kobo,
                reference,
                metadata: {
                    userId: user._id || user.id,
                    ...metadata,
                    refId: reference
                },
                bank_transfer: { account_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() }
            }, { headers, timeout: 20000 });

            if (response.data && response.data.status) {
                const data = response.data.data;
                return {
                    success: true,
                    reference,
                    accountNumber: data.account_number,
                    bankName: data.bank?.name || 'Bank',
                    accountName: data.account_name || 'Zantara Technologies',
                    amount: kobo / 100,
                    currency: 'NGN',
                    raw: data
                };
            }
            throw new Error(response.data?.message || 'Failed to initialize Paystack direct transfer');
        }

        const body = {
            email: user.email,
            amount: kobo,
            reference,
            metadata: {
                userId: user._id || user.id,
                ...metadata,
                refId: reference
            },
            callback_url: callbackUrl || `${process.env.CLIENT_BASE_URL || 'http://localhost:5173'}/paystack/return`
        };

        if (channel) {
            body.channels = [channel];
        }

        const response = await axios.post(`${this.baseUrl}/transaction/initialize`, body, { headers, timeout: 20000 });
        const resData = response.data;

        if (!resData || !resData.status) {
            throw new Error(resData?.message || 'Paystack payment initialization failed');
        }

        return {
            success: true,
            authorizationUrl: resData.data.authorization_url,
            reference: resData.data.reference || reference,
            accessCode: resData.data.access_code,
            raw: resData.data
        };
    }

    async verifyPayment(reference) {
        if (!reference) throw new Error('PaystackAdapter: reference is required for verification');

        const headers = {
            Authorization: `Bearer ${this.secretKey}`,
            'Content-Type': 'application/json'
        };

        try {
            const response = await axios.get(`${this.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`, {
                headers,
                timeout: 20000
            });

            const resData = response.data;
            // Sanitized observability for support/reconciliation: reference, HTTP
            // status and public verify verdict fields ONLY — never Authorization
            // headers, card data, customer email/PII, or metadata. This lets
            // support reconstruct the exact verify snapshot that drove a state
            // change (including the ambiguous case that historically produced
            // 'failed').
            {
                const safe = { ref: reference, httpStatus: response && response.status };
                if (resData) {
                    safe.topStatus = resData.status;
                    safe.message = resData.message;
                }
                const d = resData && resData.data;
                safe.dataStatus = d && d.status;
                safe.gatewayResponse = d && d.gateway_response;
                safe.amountKobo = d && d.amount;
                safe.currency = d && d.currency;
                safe.paidAt = d && d.paid_at;
                safe.channel = d && d.channel;
                console.log(`[PaystackVerify] ${JSON.stringify(safe)}`);
            }

            if (!resData || !resData.status || !resData.data) {
                // Ambiguous / not-yet-complete response (e.g. Paystack returns
                // status:false with "The transaction was not completed" when the
                // checkout is still pending). Treat as 'pending' — NEVER 'failed' —
                // so a later webhook/verify can still recover and credit the wallet.
                return {
                    success: false,
                    status: 'pending',
                    reference,
                    amount: 0,
                    currency: 'NGN',
                    message: resData?.message || 'Paystack verification returned an incomplete response'
                };
            }

            const data = resData.data;
            // Conservative status mapping (Paystack hardening):
            //   - 'success' ONLY on Paystack's explicit success status.
            //   - terminal 'failed' ONLY on explicit FAILED / DECLINED / CANCELLED.
            //   - 'abandoned' is NOT terminal during active checkout: Paystack returns
            //     data.status='abandoned' with gateway_response 'The transaction was not
            //     completed' and paid_at=null while a charge is STILL being finalized
            //     (mobile WebView verifies ~2s after init; the same txn becomes 'success'
            //     seconds later). Treating it as failed permanently blocks recovery.
            //     'abandoned' → 'pending' so a later verify or webhook can credit.
            //   - anything else (pending, processing, ongoing, status:false, missing/
            //     non-final data, timeouts, 5xx) is ambiguous/not-yet-complete → 'pending'
            //     so the transaction stays recoverable until a definitive answer (or
            //     webhook) arrives.
            let normalizedStatus = 'pending';
            if (data.status === 'success') normalizedStatus = 'success';
            else if (['failed', 'declined', 'cancelled'].includes(data.status)) normalizedStatus = 'failed';

            const amountNaira = (data.amount || 0) / 100;
            const currency = (data.currency || 'NGN').toUpperCase();

            return {
                success: normalizedStatus === 'success',
                status: normalizedStatus,
                reference: data.reference || reference,
                providerTransactionId: String(data.id || ''),
                amount: amountNaira,
                currency,
                message: data.gateway_response || resData.message || '',
                metadata: data.metadata,
                raw: data
            };
        } catch (err) {
            const msg = err.response?.data?.message || err.message;
            console.log(`[PaystackVerify] ${JSON.stringify({ ref: reference, httpStatus: err.response ? err.response.status : null, error: msg })}`);
            // Transport / provider error (timeout, 5xx, network). Never classify as
            // terminal 'failed' — the transaction may still complete server-side, and
            // treating it as failed permanently would block a later recovery/credit.
            return {
                success: false,
                status: 'pending',
                reference,
                amount: 0,
                currency: 'NGN',
                message: `Paystack verify error: ${msg}`
            };
        }
    }

    verifyWebhookSignature(headers, rawBody) {
        const signature = headers['x-paystack-signature'];
        if (!signature || !this.secretKey) return false;

        const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || '', 'utf8');
        const expected = crypto.createHmac('sha512', this.webhookSecret || this.secretKey).update(buf).digest('hex');
        return expected === signature;
    }

    normalizeWebhook(payload) {
        const eventData = payload?.data || {};
        const meta = typeof eventData.metadata === 'string'
            ? (() => { try { return JSON.parse(eventData.metadata); } catch (e) { return {}; } })()
            : (eventData.metadata || {});

        const isSuccess = payload.event === 'charge.success' && eventData.status === 'success';
        const isFailed = eventData.status === 'failed';

        return {
            eventId: String(eventData.id || `PS_${eventData.reference}_${Date.now()}`),
            eventType: payload.event || 'unknown',
            status: isSuccess ? 'success' : (isFailed ? 'failed' : 'pending'),
            reference: eventData.reference || meta.refId,
            providerTransactionId: String(eventData.id || ''),
            amount: (eventData.amount || 0) / 100,
            currency: (eventData.currency || 'NGN').toUpperCase(),
            userId: meta.userId,
            metadata: meta,
            raw: eventData
        };
    }

    async testConnection() {
        try {
            const response = await axios.get(`${this.baseUrl}/balance`, {
                headers: { Authorization: `Bearer ${this.secretKey}` },
                timeout: 10000
            });
            if (response.data && response.data.status) {
                const ngn = Array.isArray(response.data.data) ? response.data.data.find(b => b.currency === 'NGN') : null;
                return {
                    success: true,
                    message: 'Connected to Paystack successfully',
                    balance: ngn ? ngn.balance / 100 : 0
                };
            }
            return { success: false, message: response.data?.message || 'Paystack balance check failed' };
        } catch (err) {
            return { success: false, message: err.response?.data?.message || err.message };
        }
    }
}

module.exports = PaystackAdapter;
