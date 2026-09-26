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

    async initializePayment({ user, amount, channel, channels, reference, callbackUrl, metadata = {} }) {
        if (!user || (!user.email && !user.phone)) {
            throw this._definitiveInitializationError('MonnifyAdapter: customer email or phone is required');
        }
        if (!amount || Number(amount) < 1) {
            throw this._definitiveInitializationError('MonnifyAdapter: invalid amount');
        }

        const token = await this.getAccessToken();

        let paymentMethods = ['CARD', 'ACCOUNT_TRANSFER'];
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
            paymentMethods,
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
            return {
                success: true,
                authorizationUrl: response.data.responseBody.checkoutUrl,
                reference: response.data.responseBody.paymentReference || reference,
                raw: response.data.responseBody
            };
        }

        throw this._definitiveInitializationError(response.data?.responseMessage || 'Monnify payment initialization failed');
    }

    async createReservedAccount(user) {
        if (!user?.email && !user?.phone) {
            throw new Error('Monnify Reserved: Email or phone is required');
        }
        const token = await this.getAccessToken();
        const accountReference = `VIRTUAL_${user._id}`;
        const response = await axios.post(
            `${this.baseUrl}/api/v1/bank-transfer/reserved-accounts`,
            {
                accountReference,
                accountName: user.name || 'Customer',
                currencyCode: 'NGN',
                contractCode: this.contractCode,
                customerEmail: user.email || `${user.phone}@zantara.com`,
                customerName: user.name || 'Customer',
                getAllAvailableBanks: true,
            },
            { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
        );
        if (!response.data?.requestSuccessful) {
            throw new Error(response.data?.responseMessage || 'Monnify reserved account creation failed');
        }
        return {
            status: true,
            accounts: response.data.responseBody?.accounts || [],
            accountReference: response.data.responseBody?.accountReference,
        };
    }

    async getReservedAccount(accountReference) {
        const token = await this.getAccessToken();
        const response = await axios.get(
            `${this.baseUrl}/api/v1/bank-transfer/reserved-accounts/${encodeURIComponent(accountReference)}`,
            { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
        );
        if (!response.data?.requestSuccessful) {
            throw new Error(response.data?.responseMessage || 'Monnify reserved account lookup failed');
        }
        const body = response.data.responseBody || {};
        const accounts = Array.isArray(body.accounts)
            ? body.accounts
            : body.accountNumber
                ? [{ bankCode: body.bankCode, bankName: body.bankName, accountNumber: body.accountNumber }]
                : [];
        return { status: true, accounts, accountReference: body.accountReference };
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
        if (!signature || !this.secretKey) return false;

        const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || '', 'utf8');
        const expected = crypto.createHmac('sha512', this.webhookSecret || this.secretKey).update(buf).digest('hex');
        return expected === signature;
    }

    normalizeWebhook(payload) {
        const data = payload?.eventData || {};
        const isSuccess = payload.eventType === 'SUCCESSFUL_TRANSACTION';

        const accountRef = data.accountReference || data.destinationAccountReference;
        const virtualAccountReference = accountRef && accountRef.startsWith('VIRTUAL_') ? accountRef : null;
        const userId = virtualAccountReference
            ? virtualAccountReference.replace('VIRTUAL_', '')
            : data.metaData?.userId;

        return {
            eventId: String(data.transactionReference || `MNFY_${Date.now()}`),
            eventType: payload.eventType || 'unknown',
            status: isSuccess ? 'success' : 'pending',
            reference: data.paymentReference || accountRef,
            providerTransactionId: String(data.transactionReference || ''),
            amount: Number(data.amountPaid || 0),
            currency: (data.currencyCode || 'NGN').toUpperCase(),
            userId,
            virtualAccountReference,
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
