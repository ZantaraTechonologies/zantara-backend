const axios = require('axios');
const crypto = require('crypto');
const BasePaymentAdapter = require('./base-payment.adapter');
const {
    normalizePaystackDvaError,
    providerDeclaredPaystackError
} = require('../../utils/paystackDvaError');

class PaystackAdapter extends BasePaymentAdapter {
    constructor(gatewayConfig = {}) {
        super(gatewayConfig);
        this.baseUrl = (this.baseUrl || 'https://api.paystack.co').replace(/\/$/, '');
        this.secretKey = this.secretKey || '';
        this.publicKey = this.publicKey || '';
        this.webhookSecret = this.secretKey;
    }

    _apiHeaders() {
        if (!this.secretKey) {
            const error = new Error('PaystackAdapter: secret key is required');
            error.code = 'PAYSTACK_CONFIGURATION_INVALID';
            throw error;
        }
        return {
            Authorization: `Bearer ${this.secretKey}`,
            'Content-Type': 'application/json'
        };
    }

    getVirtualAccountCustomer(user) {
        const email = String(user?.email || '').trim().toLowerCase();
        const phone = String(user?.phone || '').trim();
        const names = String(user?.name || '').trim().split(/\s+/).filter(Boolean);
        if (!/^\S+@\S+\.\S+$/.test(email)) {
            const error = new Error('A valid email address is required for Paystack DVA provisioning');
            error.code = 'PAYSTACK_CUSTOMER_EMAIL_INVALID';
            throw error;
        }
        if (phone.length < 7) {
            const error = new Error('A valid phone number is required for Paystack DVA provisioning');
            error.code = 'PAYSTACK_CUSTOMER_PHONE_INVALID';
            throw error;
        }
        if (names.length < 2) {
            const error = new Error('A first name and last name are required for Paystack DVA provisioning');
            error.code = 'PAYSTACK_CUSTOMER_NAME_INCOMPLETE';
            throw error;
        }
        return {
            email,
            phone,
            firstName: names[0],
            lastName: names.slice(1).join(' ')
        };
    }

    _normalizeDedicatedAccount(data = {}) {
        const customer = data.customer || {};
        return {
            providerAccountId: data.id === undefined || data.id === null ? '' : String(data.id),
            accountName: data.account_name || '',
            accountNumber: data.account_number || '',
            bankName: data.bank?.name || '',
            bankCode: data.bank?.id === undefined || data.bank?.id === null ? '' : String(data.bank.id),
            bankSlug: data.bank?.slug || '',
            currency: (data.currency || 'NGN').toUpperCase(),
            active: data.active === true || data.active === 1,
            assigned: data.assigned === true || data.assigned === 1,
            providerCustomerId: customer.id === undefined || customer.id === null ? '' : String(customer.id),
            providerCustomerCode: customer.customer_code || '',
            raw: data
        };
    }

    _normalizeCustomer(data = {}) {
        return {
            providerCustomerId: data.id === undefined || data.id === null ? '' : String(data.id),
            providerCustomerCode: data.customer_code || '',
            email: data.email || '',
            firstName: data.first_name || '',
            lastName: data.last_name || '',
            phone: data.phone || '',
            dedicatedAccount: data.dedicated_account
                ? this._normalizeDedicatedAccount({ ...data.dedicated_account, customer: data })
                : null,
            raw: data
        };
    }

    _normalizeDedicatedNubanDeposit(data = {}) {
        const authorization = data.authorization || {};
        const customer = data.customer || {};
        const transactionChannel = String(data.channel || '').trim().toLowerCase();
        const authorizationChannel = String(authorization.channel || '').trim().toLowerCase();
        return {
            claimsDedicatedNuban: transactionChannel === 'dedicated_nuban' || authorizationChannel === 'dedicated_nuban',
            isDedicatedNuban: authorizationChannel === 'dedicated_nuban',
            transactionChannel,
            authorizationChannel,
            receiverAccountNumber: String(authorization.receiver_bank_account_number || '').trim(),
            receiverBank: String(authorization.receiver_bank || '').trim(),
            providerCustomerId: customer.id === undefined || customer.id === null ? '' : String(customer.id),
            providerCustomerCode: String(customer.customer_code || '').trim()
        };
    }

    async createCustomer({ email, firstName, lastName, phone }) {
        if (!email || !firstName || !lastName || !phone) {
            const error = new Error('Paystack customer requires email, first name, last name, and phone');
            error.code = 'PAYSTACK_CUSTOMER_DATA_INVALID';
            throw error;
        }

        let response;
        try {
            response = await axios.post(`${this.baseUrl}/customer`, {
                email,
                first_name: firstName,
                last_name: lastName,
                phone
            }, { headers: this._apiHeaders(), timeout: 20000 });
        } catch (error) {
            throw normalizePaystackDvaError(error, { operation: 'create_customer', mutation: true });
        }

        if (!response.data?.status || !response.data?.data) {
            throw normalizePaystackDvaError(providerDeclaredPaystackError(response), {
                operation: 'create_customer',
                mutation: true
            });
        }
        return this._normalizeCustomer(response.data.data);
    }

    async fetchCustomer(identifier) {
        if (!identifier) {
            const error = new Error('Paystack customer identifier is required');
            error.code = 'PAYSTACK_CUSTOMER_IDENTIFIER_REQUIRED';
            throw error;
        }

        try {
            const response = await axios.get(`${this.baseUrl}/customer/${encodeURIComponent(identifier)}`, {
                headers: this._apiHeaders(),
                timeout: 20000
            });
            if (!response.data?.status || !response.data?.data) return null;
            return this._normalizeCustomer(response.data.data);
        } catch (error) {
            if (Number(error.response?.status) === 404) return null;
            throw normalizePaystackDvaError(error, { operation: 'fetch_customer' });
        }
    }

    async createDedicatedVirtualAccount({ customer, preferredBank, firstName, lastName, phone }) {
        if (!customer) {
            const error = new Error('Paystack customer ID or code is required for DVA creation');
            error.code = 'PAYSTACK_CUSTOMER_IDENTIFIER_REQUIRED';
            throw error;
        }
        if (!preferredBank) {
            const error = new Error('Paystack preferred bank is required for DVA creation');
            error.code = 'PAYSTACK_DVA_BANK_REQUIRED';
            throw error;
        }

        const body = {
            customer,
            preferred_bank: preferredBank,
            ...(firstName ? { first_name: firstName } : {}),
            ...(lastName ? { last_name: lastName } : {}),
            ...(phone ? { phone } : {})
        };
        let response;
        try {
            response = await axios.post(`${this.baseUrl}/dedicated_account`, body, {
                headers: this._apiHeaders(),
                timeout: 20000
            });
        } catch (error) {
            throw normalizePaystackDvaError(error, { operation: 'create_dedicated_account', mutation: true });
        }

        if (!response.data?.status) {
            throw normalizePaystackDvaError(providerDeclaredPaystackError(response), {
                operation: 'create_dedicated_account',
                mutation: true
            });
        }
        const account = response.data.data
            ? this._normalizeDedicatedAccount(response.data.data)
            : null;
        return {
            success: true,
            status: account?.accountNumber && account.active && account.assigned ? 'active' : 'pending',
            message: response.data.message || '',
            account,
            raw: response.data.data || null
        };
    }

    async assignDedicatedVirtualAccount({ email, firstName, lastName, phone, preferredBank, country = 'NG', accountNumber, bvn, bankCode }) {
        if (!email || !firstName || !lastName || !phone || !preferredBank || !country) {
            const error = new Error('Paystack DVA assignment requires email, first name, last name, phone, preferred bank, and country');
            error.code = 'PAYSTACK_CUSTOMER_DATA_INVALID';
            throw error;
        }
        let response;
        try {
            response = await axios.post(`${this.baseUrl}/dedicated_account/assign`, {
                email,
                first_name: firstName,
                last_name: lastName,
                phone,
                preferred_bank: preferredBank,
                country,
                ...(accountNumber ? { account_number: accountNumber } : {}),
                ...(bvn ? { bvn } : {}),
                ...(bankCode ? { bank_code: bankCode } : {})
            }, { headers: this._apiHeaders(), timeout: 20000 });
        } catch (error) {
            throw normalizePaystackDvaError(error, { operation: 'assign_dedicated_account', mutation: true });
        }

        if (!response.data?.status) {
            throw normalizePaystackDvaError(providerDeclaredPaystackError(response), {
                operation: 'assign_dedicated_account',
                mutation: true
            });
        }
        return { success: true, status: 'pending', message: response.data.message || '', raw: response.data.data || null };
    }

    async fetchDedicatedVirtualAccount(dedicatedAccountId) {
        if (dedicatedAccountId === undefined || dedicatedAccountId === null || dedicatedAccountId === '') {
            const error = new Error('Paystack dedicated account ID is required');
            error.code = 'PAYSTACK_DVA_IDENTIFIER_REQUIRED';
            throw error;
        }
        try {
            const response = await axios.get(`${this.baseUrl}/dedicated_account/${encodeURIComponent(dedicatedAccountId)}`, {
                headers: this._apiHeaders(),
                timeout: 20000
            });
            if (!response.data?.status || !response.data?.data) {
                throw new Error(response.data?.message || 'Paystack DVA lookup failed');
            }
            return this._normalizeDedicatedAccount(response.data.data);
        } catch (error) {
            if (Number(error.response?.status) === 404) return null;
            throw normalizePaystackDvaError(error, { operation: 'fetch_dedicated_account' });
        }
    }

    async listDedicatedAccountProviders() {
        let response;
        try {
            response = await axios.get(`${this.baseUrl}/dedicated_account/available_providers`, {
                headers: this._apiHeaders(),
                timeout: 20000
            });
        } catch (error) {
            throw normalizePaystackDvaError(error, { operation: 'list_dedicated_account_providers' });
        }
        if (!response.data?.status || !Array.isArray(response.data?.data)) {
            throw normalizePaystackDvaError(providerDeclaredPaystackError(response), {
                operation: 'list_dedicated_account_providers'
            });
        }
        return response.data.data.map(provider => ({
            providerSlug: provider.provider_slug,
            bankId: provider.bank_id === undefined || provider.bank_id === null ? '' : String(provider.bank_id),
            bankName: provider.bank_name || ''
        }));
    }

    async initializePayment({ user, amount, channel, channels, reference, callbackUrl, metadata = {}, isDirectTransfer = false }) {
        if (!user || !user.email) throw this._definitiveInitializationError('PaystackAdapter: customer email is required');
        const kobo = Math.round(Number(amount) * 100);
        if (!kobo || kobo < 1) throw this._definitiveInitializationError('PaystackAdapter: invalid amount');

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
            throw this._definitiveInitializationError(response.data?.message || 'Failed to initialize Paystack direct transfer');
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

        if (channel || (Array.isArray(channels) && channels.length > 0)) {
            body.channels = channel ? [channel] : channels;
        }

        const response = await axios.post(`${this.baseUrl}/transaction/initialize`, body, { headers, timeout: 20000 });
        const resData = response.data;

        if (!resData || !resData.status) {
            throw this._definitiveInitializationError(resData?.message || 'Paystack payment initialization failed');
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
                amountKobo: Number(data.amount),
                currency,
                message: data.gateway_response || resData.message || '',
                metadata: data.metadata,
                dedicatedNuban: this._normalizeDedicatedNubanDeposit(data),
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
        if (!/^[a-f\d]{128}$/i.test(signature)) return false;
        return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
    }

    normalizeWebhook(payload) {
        const eventData = payload?.data || {};
        const eventType = payload?.event || 'unknown';
        if (['dedicatedaccount.assign.success', 'dedicatedaccount.assign.failed'].includes(eventType)) {
            const accountData = eventData.dedicated_account || eventData.dedicatedAccount || eventData.account || eventData;
            const customerData = accountData.customer || eventData.customer || {};
            const providerCustomerId = customerData.id ?? eventData.customer_id;
            const providerCustomerCode = customerData.customer_code || eventData.customer_code || '';
            const hasAccountEvidence = !!(
                accountData.account_number
                || eventData.dedicated_account
                || eventData.dedicatedAccount
                || eventData.account
            );
            const account = hasAccountEvidence
                ? this._normalizeDedicatedAccount({
                    ...accountData,
                    customer: {
                        ...customerData,
                        ...(providerCustomerId !== undefined ? { id: providerCustomerId } : {}),
                        ...(providerCustomerCode ? { customer_code: providerCustomerCode } : {})
                    }
                })
                : null;
            const payloadDigest = crypto
                .createHash('sha256')
                .update(JSON.stringify(payload || {}))
                .digest('hex');

            return {
                eventId: `paystack-dva:${eventType}:${payloadDigest}`,
                eventType,
                eventDomain: 'virtual_account_provisioning',
                status: eventType.endsWith('.success') ? 'success' : 'failed',
                virtualAccount: {
                    providerCustomerId: providerCustomerId === undefined || providerCustomerId === null
                        ? ''
                        : String(providerCustomerId),
                    providerCustomerCode,
                    account,
                    reason: eventData.reason || eventData.message || 'Paystack DVA assignment failed'
                },
                raw: eventData
            };
        }

        const meta = typeof eventData.metadata === 'string'
            ? (() => { try { return JSON.parse(eventData.metadata); } catch (e) { return {}; } })()
            : (eventData.metadata || {});

        const isSuccess = payload.event === 'charge.success' && eventData.status === 'success';
        const isFailed = eventData.status === 'failed';

        return {
            eventId: String(eventData.id || `PS_${eventData.reference}_${Date.now()}`),
            eventType,
            status: isSuccess ? 'success' : (isFailed ? 'failed' : 'pending'),
            reference: eventData.reference || meta.refId,
            providerTransactionId: String(eventData.id || ''),
            amount: (eventData.amount || 0) / 100,
            amountKobo: Number(eventData.amount),
            currency: (eventData.currency || 'NGN').toUpperCase(),
            userId: meta.userId,
            metadata: meta,
            dedicatedNuban: this._normalizeDedicatedNubanDeposit(eventData),
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
