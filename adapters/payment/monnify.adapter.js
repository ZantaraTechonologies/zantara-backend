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
            throw new Error('MonnifyAdapter: API key and Secret key are required for authentication');
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

        throw new Error(response.data?.responseMessage || 'Monnify Authentication Failed');
    }

    async initializePayment({ user, amount, channel, reference, callbackUrl, metadata = {} }) {
        if (!user || (!user.email && !user.phone)) {
            throw new Error('MonnifyAdapter: customer email or phone is required');
        }
        if (!amount || Number(amount) < 1) {
            throw new Error('MonnifyAdapter: invalid amount');
        }

        const token = await this.getAccessToken();

        let paymentMethods = ['CARD', 'ACCOUNT_TRANSFER'];
        if (channel === 'card') paymentMethods = ['CARD'];
        if (channel === 'bank_transfer') paymentMethods = ['ACCOUNT_TRANSFER'];

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

        throw new Error(response.data?.responseMessage || 'Monnify payment initialization failed');
    }

    async verifyPayment(reference) {
        if (!reference) throw new Error('MonnifyAdapter: reference is required for verification');

        const token = await this.getAccessToken();

        try {
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
                    status: 'failed',
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
            // Fallback to query endpoint if v2 by path fails
            try {
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
                    return {
                        success: isPaid,
                        status: isPaid ? 'success' : 'pending',
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
                status: 'failed',
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

        let userId = data.metaData?.userId;
        const accountRef = data.accountReference || data.destinationAccountReference;
        if (!userId && accountRef && accountRef.startsWith('VIRTUAL_')) {
            userId = accountRef.replace('VIRTUAL_', '');
        }

        return {
            eventId: String(data.transactionReference || `MNFY_${Date.now()}`),
            eventType: payload.eventType || 'unknown',
            status: isSuccess ? 'success' : 'pending',
            reference: data.paymentReference || accountRef,
            providerTransactionId: String(data.transactionReference || ''),
            amount: Number(data.amountPaid || 0),
            currency: (data.currencyCode || 'NGN').toUpperCase(),
            userId,
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
