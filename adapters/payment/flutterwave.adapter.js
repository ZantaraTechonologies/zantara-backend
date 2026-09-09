const axios = require('axios');
const BasePaymentAdapter = require('./base-payment.adapter');

class FlutterwaveAdapter extends BasePaymentAdapter {
    constructor(gatewayConfig = {}) {
        super(gatewayConfig);
        this.baseUrl = (this.baseUrl || process.env.FLUTTERWAVE_BASE_URL || 'https://api.flutterwave.com/v3').replace(/\/$/, '');
        this.secretKey = this.secretKey || process.env.FLUTTERWAVE_SECRET_KEY || '';
        this.publicKey = this.publicKey || process.env.FLUTTERWAVE_PUBLIC_KEY || '';
        this.webhookSecret = this.webhookSecret || process.env.FLUTTERWAVE_HASH || '';
    }

    async initializePayment({ user, amount, channel, reference, callbackUrl, metadata = {} }) {
        if (!user || !user.email) {
            throw new Error('FlutterwaveAdapter: customer email is required');
        }
        if (!amount || Number(amount) < 1) {
            throw new Error('FlutterwaveAdapter: invalid amount');
        }

        const config = {
            headers: {
                Authorization: `Bearer ${this.secretKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 20000
        };

        const body = {
            tx_ref: reference,
            amount: Number(amount),
            currency: 'NGN',
            redirect_url: callbackUrl || `${process.env.CLIENT_BASE_URL || 'http://localhost:5173'}/flutterwave/return`,
            customer: {
                email: user.email,
                name: user.name || 'Customer'
            },
            meta: {
                userId: user._id || user.id,
                ...metadata,
                refId: reference
            },
            customizations: {
                title: 'Wallet Funding',
                description: 'Payment for wallet funding'
            }
        };

        if (channel === 'card') body.payment_options = 'card';
        else if (channel === 'bank_transfer') body.payment_options = 'account,banktransfer';
        else if (channel === 'ussd') body.payment_options = 'ussd';

        const response = await axios.post(`${this.baseUrl}/payments`, body, config);
        const resData = response.data;

        if (resData && resData.status === 'success' && resData.data) {
            return {
                success: true,
                authorizationUrl: resData.data.link,
                reference,
                raw: resData.data
            };
        }

        throw new Error(resData?.message || 'Flutterwave payment initialization failed');
    }

    async verifyPayment(reference) {
        if (!reference) throw new Error('FlutterwaveAdapter: reference is required for verification');

        const config = {
            headers: {
                Authorization: `Bearer ${this.secretKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 20000
        };

        try {
            // Flutterwave verify by reference endpoint
            const response = await axios.get(
                `${this.baseUrl}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`,
                config
            );

            const resData = response.data;
            if (!resData || resData.status !== 'success' || !resData.data) {
                return {
                    success: false,
                    status: 'failed',
                    reference,
                    amount: 0,
                    currency: 'NGN',
                    message: resData?.message || 'Flutterwave verification returned no data'
                };
            }

            const data = resData.data;
            const isSuccess = String(data.status || '').toLowerCase() === 'successful';
            const isFailed = ['failed', 'cancelled'].includes(String(data.status || '').toLowerCase());

            return {
                success: isSuccess,
                status: isSuccess ? 'success' : (isFailed ? 'failed' : 'pending'),
                reference: data.tx_ref || reference,
                providerTransactionId: String(data.id || ''),
                amount: Number(data.amount || 0),
                currency: (data.currency || 'NGN').toUpperCase(),
                message: data.processor_response || resData.message || '',
                metadata: data.meta,
                raw: data
            };
        } catch (err) {
            const msg = err.response?.data?.message || err.message;
            return {
                success: false,
                status: 'failed',
                reference,
                amount: 0,
                currency: 'NGN',
                message: `Flutterwave verify error: ${msg}`
            };
        }
    }

    verifyWebhookSignature(headers, rawBody) {
        const signature = headers['verif-hash'];
        if (!signature || !this.webhookSecret) return false;
        return signature === this.webhookSecret;
    }

    normalizeWebhook(payload) {
        const data = payload?.data || {};
        const isSuccess = (payload.status === 'successful' || payload.event === 'charge.completed')
            && String(data.status || '').toLowerCase() === 'successful';

        return {
            eventId: String(data.id || `FLW_${data.tx_ref}_${Date.now()}`),
            eventType: payload.event || 'charge.completed',
            status: isSuccess ? 'success' : 'pending',
            reference: data.tx_ref,
            providerTransactionId: String(data.id || ''),
            amount: Number(data.amount || 0),
            currency: (data.currency || 'NGN').toUpperCase(),
            userId: data.meta?.userId,
            metadata: data.meta || {},
            raw: data
        };
    }

    async testConnection() {
        try {
            const response = await axios.get(`${this.baseUrl}/balances`, {
                headers: { Authorization: `Bearer ${this.secretKey}` },
                timeout: 10000
            });
            if (response.data && response.data.status === 'success') {
                return {
                    success: true,
                    message: 'Connected to Flutterwave successfully'
                };
            }
            return { success: false, message: response.data?.message || 'Flutterwave test connection failed' };
        } catch (err) {
            return { success: false, message: err.response?.data?.message || err.message };
        }
    }
}

module.exports = FlutterwaveAdapter;
