const axios = require('axios');
const crypto = require('crypto');
const BasePaymentAdapter = require('./base-payment.adapter');

class MonnifyAdapter extends BasePaymentAdapter {
    constructor(gatewayConfig = {}) {
        super(gatewayConfig);
        this.baseUrl = (this.baseUrl || process.env.MONNIFY_BASE_URL || 'https://sandbox.monnify.com').replace(/\/$/, '');
        this.apiKey = this.publicKey || process.env.MONNIFY_API_KEY || '';
        this.secretKey = this.secretKey || process.env.MONNIFY_SECRET_KEY || '';
        this.webhookSecret = this.webhookSecret || this.secretKey;
        this.contractCode = this.metadata?.contractCode || process.env.MONNIFY_CONTRACT_CODE || '';
        this.cachedToken = null;
        this.tokenExpiry = null;
        this.requiresVerifiedBankIdentity = true;
    }

    async getAccessToken() {
        if (this.cachedToken && this.tokenExpiry && new Date() < this.tokenExpiry) {
            return this.cachedToken;
        }

        if (!this.apiKey || !this.secretKey) {
            throw this._definitiveInitializationError('MonnifyAdapter: API key and Secret key are required for authentication');
        }

        const auth = Buffer.from(`${this.apiKey}:${this.secretKey}`).toString('base64');
        const response = await axios.post(`${this.baseUrl}/api/v1/auth/login`, {}, {
            headers: { Authorization: `Basic ${auth}` },
            timeout: 15000
        });

        if (response.data && response.data.requestSuccessful) {
            this.cachedToken = response.data.responseBody.accessToken;
            const expiresIn = response.data.responseBody.expiresIn || 3600;
            this.tokenExpiry = new Date(Date.now() + (expiresIn - 300) * 1000);
            return this.cachedToken;
        }

        throw this._definitiveInitializationError(response.data?.responseMessage || 'Monnify Authentication Failed');
    }

    assertVirtualAccountCustomer(user) {
        const email = String(user?.email || '').trim();
        const name = String(user?.name || '').trim();
        if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
            const error = new Error('A valid email address is required for Monnify virtual-account provisioning');
            error.code = 'MONNIFY_CUSTOMER_DATA_INVALID';
            throw error;
        }
        if (!name) {
            const error = new Error('Customer name is required for Monnify virtual-account provisioning');
            error.code = 'MONNIFY_CUSTOMER_DATA_INVALID';
            throw error;
        }
        return true;
    }

    _verifiedIdentityFields(verifiedIdentity) {
        const bvn = String(verifiedIdentity?.bvn || '').trim();
        const nin = String(verifiedIdentity?.nin || '').trim();
        if (
            verifiedIdentity?.verified !== true
            || (!/^\d{11}$/.test(bvn) && !/^\d{11}$/.test(nin))
            || (bvn && !/^\d{11}$/.test(bvn))
            || (nin && !/^\d{11}$/.test(nin))
        ) {
            const error = new Error('Verified BVN or NIN is required for Monnify virtual-account provisioning');
            error.code = 'MONNIFY_IDENTITY_VERIFICATION_REQUIRED';
            error.provisioningDisposition = 'definitive_rejection';
            throw error;
        }
        return { ...(bvn ? { bvn } : {}), ...(nin ? { nin } : {}) };
    }

    _reservedAccountError(error, { stage, requestDispatched = false } = {}) {
        const status = Number(error?.response?.status);
        const providerBody = error?.response?.data || {};
        const normalized = new Error(providerBody.responseMessage || error?.message || 'Monnify reserved-account request failed');
        normalized.code = providerBody.responseCode
            || error?.code
            || (status === 404 ? 'MONNIFY_RESERVED_ACCOUNT_NOT_FOUND' : 'MONNIFY_RESERVED_ACCOUNT_REQUEST_FAILED');
        normalized.providerHttpStatus = Number.isInteger(status) ? status : undefined;
        normalized.providerResponseCode = providerBody.responseCode || undefined;
        normalized.operationStage = stage;
        normalized.requestDispatched = requestDispatched;
        if (Number.isInteger(status)) normalized.response = { status };
        return normalized;
    }

    _reservedAccountResult(body = {}) {
        return {
            status: true,
            apiVersion: 'v2',
            contractCode: String(body.contractCode || body.contract?.code || ''),
            accountReference: String(body.accountReference || ''),
            accountName: String(body.accountName || ''),
            currencyCode: String(body.currencyCode || ''),
            customerEmail: String(body.customerEmail || ''),
            customerName: String(body.customerName || ''),
            reservationReference: String(body.reservationReference || ''),
            reservedAccountType: String(body.reservedAccountType || ''),
            providerStatus: String(body.status || ''),
            accounts: Array.isArray(body.accounts)
                ? body.accounts.map(account => ({
                    bankCode: String(account?.bankCode || ''),
                    bankName: String(account?.bankName || ''),
                    accountNumber: String(account?.accountNumber || ''),
                    accountName: String(account?.accountName || body.accountName || '')
                }))
                : []
        };
    }

    async initializePayment({ user, amount, channel, channels, reference, callbackUrl, metadata = {} }) {
        if (!user || (!user.email && !user.phone)) {
            throw this._definitiveInitializationError('MonnifyAdapter: customer email or phone is required');
        }
        if (!amount || Number(amount) < 1) {
            throw this._definitiveInitializationError('MonnifyAdapter: invalid amount');
        }

        let token;
        try {
            token = await this.getAccessToken();
        } catch (error) {
            if (error?.gatewayInitializationOutcome === 'definitive_failure') throw error;
            const preflightError = this._definitiveInitializationError(
                error?.message || 'Monnify authentication unavailable'
            );
            preflightError.cause = error;
            throw preflightError;
        }

        let paymentMethods;
        if (channel === 'card') paymentMethods = ['CARD'];
        if (channel === 'bank_transfer') paymentMethods = ['ACCOUNT_TRANSFER'];
        if (channel === 'virtual_account') paymentMethods = ['ACCOUNT_TRANSFER'];
        if (!channel && Array.isArray(channels) && channels.length > 0) {
            const mapped = { card: 'CARD', bank_transfer: 'ACCOUNT_TRANSFER', virtual_account: 'ACCOUNT_TRANSFER' };
            paymentMethods = [...new Set(channels.map(item => mapped[item]).filter(Boolean))];
        }

        const body = {
            amount: Number(amount),
            customerName: user.name || 'Customer',
            customerEmail: user.email || `${user.phone || 'customer'}@zantara.com`,
            paymentReference: reference,
            paymentDescription: 'Wallet Funding',
            currencyCode: 'NGN',
            contractCode: this.contractCode,
            redirectUrl: callbackUrl || `${process.env.CLIENT_BASE_URL || 'http://localhost:5173'}/monnify/return`,
            ...(paymentMethods?.length ? { paymentMethods } : {}),
            metadata: {
                userId: user._id || user.id,
                ...metadata,
                refId: reference
            }
        };

        const response = await axios.post(`${this.baseUrl}/api/v1/merchant/transactions/init-transaction`, body, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 20000
        });

        if (response.data && response.data.requestSuccessful) {
            const checkoutUrl = String(response.data.responseBody?.checkoutUrl || '').trim();
            let trustedCheckout = false;
            try {
                const parsedCheckout = new URL(checkoutUrl);
                const host = parsedCheckout.hostname.toLowerCase();
                trustedCheckout = parsedCheckout.protocol === 'https:'
                    && !parsedCheckout.username
                    && !parsedCheckout.password
                    && (!parsedCheckout.port || parsedCheckout.port === '443')
                    && (host === 'monnify.com' || host.endsWith('.monnify.com'));
            } catch (_) {}
            if (!trustedCheckout) {
                const error = new Error('Monnify returned an invalid hosted checkout URL');
                error.code = 'MONNIFY_INITIALIZATION_RESPONSE_INVALID';
                throw error;
            }
            return {
                success: true,
                authorizationUrl: checkoutUrl,
                reference: response.data.responseBody.paymentReference || reference,
                raw: response.data.responseBody
            };
        }

        throw this._definitiveInitializationError(response.data?.responseMessage || 'Monnify payment initialization failed');
    }

    async createReservedAccount({ user, accountReference, verifiedIdentity } = {}) {
        this.assertVirtualAccountCustomer(user);
        if (!/^VIRTUAL_[a-f\d]{24}$/i.test(String(accountReference || ''))) {
            const error = new Error('A deterministic Monnify account reference is required');
            error.code = 'MONNIFY_ACCOUNT_REFERENCE_INVALID';
            error.provisioningDisposition = 'definitive_rejection';
            throw error;
        }
        if (!this.contractCode) {
            const error = new Error('Monnify contract code is required for reserved-account provisioning');
            error.code = 'MONNIFY_CONTRACT_CODE_REQUIRED';
            error.provisioningDisposition = 'definitive_rejection';
            throw error;
        }
        const identityFields = this._verifiedIdentityFields(verifiedIdentity);
        let token;
        try {
            token = await this.getAccessToken();
        } catch (error) {
            error.operationStage = 'authentication';
            error.requestDispatched = false;
            throw error;
        }
        let response;
        try {
            response = await axios.post(
                `${this.baseUrl}/api/v2/bank-transfer/reserved-accounts`,
                {
                    accountReference,
                    accountName: user.name.trim(),
                    currencyCode: 'NGN',
                    contractCode: this.contractCode,
                    customerEmail: user.email.trim(),
                    customerName: user.name.trim(),
                    ...identityFields,
                    getAllAvailableBanks: true
                },
                { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
            );
        } catch (error) {
            throw this._reservedAccountError(error, { stage: 'create', requestDispatched: true });
        }
        if (!response.data?.requestSuccessful) {
            throw this._reservedAccountError({
                message: response.data?.responseMessage,
                response: { status: 502, data: response.data }
            }, { stage: 'create', requestDispatched: true });
        }
        return this._reservedAccountResult(response.data.responseBody);
    }

    async getReservedAccount(accountReference) {
        const token = await this.getAccessToken();
        let response;
        try {
            response = await axios.get(
                `${this.baseUrl}/api/v2/bank-transfer/reserved-accounts/${encodeURIComponent(accountReference)}`,
                { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
            );
        } catch (error) {
            throw this._reservedAccountError(error, { stage: 'lookup' });
        }
        if (!response.data?.requestSuccessful) {
            throw this._reservedAccountError({
                message: response.data?.responseMessage,
                response: { status: 502, data: response.data }
            }, { stage: 'lookup' });
        }
        return this._reservedAccountResult(response.data.responseBody);
    }

    async verifyReservedAccountOwnership({ accountReference, accountNumber }) {
        if (!accountReference || !accountNumber) return false;
        const result = await this.getReservedAccount(accountReference);
        return result?.accountReference === accountReference
            && result?.contractCode === this.contractCode
            && result?.currencyCode === 'NGN'
            && result?.reservedAccountType === 'GENERAL'
            && result?.providerStatus === 'ACTIVE'
            && Array.isArray(result.accounts)
            && result.accounts.some(account => String(account?.accountNumber || '') === String(accountNumber));
    }

    async verifyPayment(reference) {
        if (!reference) throw new Error('MonnifyAdapter: reference is required for verification');

        let token;
        try {
            token = await this.getAccessToken();
            // Official Monnify v2 transaction status query endpoint
            const response = await axios.get(
                `${this.baseUrl}/api/v2/transactions/${encodeURIComponent(reference)}`,
                {
                    headers: { Authorization: `Bearer ${token}` },
                    timeout: 20000
                }
            );

            const resData = response.data;
            if (!resData || !resData.requestSuccessful || !resData.responseBody) {
                return {
                    success: false,
                    status: 'pending',
                    reference,
                    amount: 0,
                    currency: 'NGN',
                    message: resData?.responseMessage || 'Monnify verification returned no data'
                };
            }

            const body = resData.responseBody;
            let normalizedStatus = 'pending';
            const payStatus = String(body.paymentStatus || '').toUpperCase();

            if (payStatus === 'PAID' || payStatus === 'OVERPAID') {
                normalizedStatus = 'success';
            } else if (['FAILED', 'EXPIRED', 'CANCELLED'].includes(payStatus)) {
                normalizedStatus = 'failed';
            }

            const amountPaid = Number(body.amountPaid ?? body.payableAmount ?? 0);
            const currency = (body.currencyCode || 'NGN').toUpperCase();

            return {
                success: normalizedStatus === 'success',
                status: normalizedStatus,
                reference: body.paymentReference || reference,
                providerTransactionId: String(body.transactionReference || ''),
                amount: amountPaid,
                currency,
                message: body.paymentStatus || resData.responseMessage || '',
                metadata: body.metaData,
                raw: body
            };
        } catch (err) {
            // Fallback to query endpoint if v2 by path fails and authentication
            // succeeded. A transport failure is inconclusive, never terminal.
            try {
                if (!token) throw new Error('Monnify access token unavailable');
                const queryRes = await axios.get(
                    `${this.baseUrl}/api/v1/merchant/transactions/query?paymentReference=${encodeURIComponent(reference)}`,
                    {
                        headers: { Authorization: `Bearer ${token}` },
                        timeout: 15000
                    }
                );
                if (queryRes.data && queryRes.data.requestSuccessful && queryRes.data.responseBody) {
                    const body = queryRes.data.responseBody;
                    const payStatus = String(body.paymentStatus || '').toUpperCase();
                    const isPaid = payStatus === 'PAID' || payStatus === 'OVERPAID';
                    const isFailed = ['FAILED', 'EXPIRED', 'CANCELLED'].includes(payStatus);
                    return {
                        success: isPaid,
                        status: isPaid ? 'success' : (isFailed ? 'failed' : 'pending'),
                        reference: body.paymentReference || reference,
                        providerTransactionId: String(body.transactionReference || ''),
                        amount: Number(body.amountPaid ?? 0),
                        currency: (body.currencyCode || 'NGN').toUpperCase(),
                        raw: body
                    };
                }
            } catch (fallbackErr) {
                // Ignore fallback error and return original error below
            }

            const msg = err.response?.data?.responseMessage || err.message;
            return {
                success: false,
                status: 'pending',
                reference,
                amount: 0,
                currency: 'NGN',
                message: `Monnify verify error: ${msg}`
            };
        }
    }

    verifyWebhookSignature(headers, rawBody) {
        const signature = headers['monnify-signature'];
        if (!signature || (!this.webhookSecret && !this.secretKey)) return false;

        const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || '', 'utf8');
        const expected = crypto.createHmac('sha512', this.webhookSecret || this.secretKey).update(buf).digest('hex');
        return expected === signature;
    }

    normalizeWebhook(payload) {
        const data = payload?.eventData || {};
        const isSuccess = payload.eventType === 'SUCCESSFUL_TRANSACTION';

        const product = data.product || {};
        const productReference = String(product.type || '').toUpperCase() === 'RESERVED_ACCOUNT'
            ? product.reference
            : null;
        const accountRef = productReference || data.accountReference || data.destinationAccountReference;
        const virtualAccountReference = accountRef && accountRef.startsWith('VIRTUAL_') ? accountRef : null;
        const userId = virtualAccountReference
            ? virtualAccountReference.replace('VIRTUAL_', '')
            : data.metaData?.userId;
        const destination = data.destinationAccountInformation || data.destinationAccount || {};
        const destinationAccountNumber = String(
            destination.accountNumber
            || data.destinationAccountNumber
            || data.accountNumber
            || ''
        ).trim();
        const destinationBankCode = String(destination.bankCode || data.destinationBankCode || '').trim();
        const fallbackEventId = crypto.createHash('sha256')
            .update(JSON.stringify(payload || {}))
            .digest('hex')
            .slice(0, 32);

        return {
            eventId: String(data.transactionReference || `MNFY_${fallbackEventId}`),
            eventType: payload.eventType || 'unknown',
            status: isSuccess ? 'success' : 'pending',
            reference: data.paymentReference || accountRef,
            providerTransactionId: String(data.transactionReference || ''),
            amount: Number(data.amountPaid || 0),
            currency: (data.currency || data.currencyCode || 'NGN').toUpperCase(),
            userId,
            virtualAccountReference,
            destinationAccountNumber,
            destinationBankCode,
            metadata: data.metaData || {},
            raw: data
        };
    }

    async testConnection() {
        try {
            const token = await this.getAccessToken();
            return {
                success: !!token,
                message: 'Connected to Monnify successfully'
            };
        } catch (err) {
            return {
                success: false,
                message: err.message
            };
        }
    }
}

module.exports = MonnifyAdapter;
