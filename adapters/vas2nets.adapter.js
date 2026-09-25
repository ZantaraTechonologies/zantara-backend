const axios = require('axios');
const BaseAdapter = require('./base.adapter');
const { PROVIDER_OUTCOMES } = require('../utils/providerOutcome');
const { normalizeFulfillment } = require('../utils/fulfillment');

const SUCCESS_CODES = new Set(['000', '200']);
const PENDING_CODES = new Set(['099']);
const FAILURE_CODES = new Set(['400', '401', '403', '404', '409', '422']);
const SUCCESS_STATUSES = new Set(['success', 'successful', 'delivered', 'completed']);
const PENDING_STATUSES = new Set(['pending', 'processing', 'queued', 'in_progress', 'in-progress']);
const FAILURE_STATUSES = new Set(['failed', 'rejected', 'cancelled', 'canceled']);

const transportError = err => ({
    success: false,
    status: 'unknown',
    outcome: PROVIDER_OUTCOMES.UNKNOWN,
    message: err.message,
    raw: err.response?.data,
});

class Vas2NetsAdapter extends BaseAdapter {
    constructor(config) {
        super(config);
        // Vas2Nets often uses Username/Password in metadata or specific fields
        this.auth = {
            username: config.metadata?.username || config.apiKey,
            password: config.metadata?.password || config.secretKey
        };
    }

    async purchaseAirtime({ request_id, serviceID, phone, amount }) {
        try {
            const res = await axios.post(`${this.baseUrl}/pay`, { 
                auth: this.auth,
                request_id, serviceID, phone, amount
            }, { timeout: 30000 });
            return this.mapResponse(res.data);
        } catch (err) {
            return transportError(err);
        }
    }

    async purchaseData({ request_id, serviceID, billersCode, variation_code, phone, amount }) {
        try {
            const res = await axios.post(`${this.baseUrl}/pay`, { 
                auth: this.auth,
                request_id, serviceID, billersCode, variation_code, phone, amount
            }, { timeout: 30000 });
            return this.mapResponse(res.data);
        } catch (err) {
            return transportError(err);
        }
    }

    async purchaseElectricity({ request_id, serviceID, billersCode, variation_code, amount, phone }) {
        try {
            const res = await axios.post(`${this.baseUrl}/pay`, { 
                auth: this.auth,
                request_id, serviceID, billersCode, variation_code, amount, phone
            }, { timeout: 30000 });
            return this.mapResponse(res.data);
        } catch (err) {
            return transportError(err);
        }
    }

    async purchaseCable({ request_id, serviceID, billersCode, variation_code, amount, phone }) {
        try {
            const res = await axios.post(`${this.baseUrl}/pay`, { 
                auth: this.auth,
                request_id, serviceID, billersCode, variation_code, amount, phone
            }, { timeout: 30000 });
            return this.mapResponse(res.data);
        } catch (err) {
            return transportError(err);
        }
    }

    async purchaseExamPin({ request_id, serviceID, variation_code, amount, quantity, phone }) {
        try {
            const res = await axios.post(`${this.baseUrl}/pay`, { 
                auth: this.auth,
                request_id, serviceID, variation_code, amount, quantity, phone
            }, { timeout: 30000 });
            return this.mapResponse(res.data);
        } catch (err) {
            return transportError(err);
        }
    }

    async queryTransaction(request_id) {
        try {
            const res = await axios.post(`${this.baseUrl}/requery`, { 
                auth: this.auth, 
                request_id 
            }, { timeout: 15000 });
            return this.mapResponse(res.data);
        } catch (err) {
            return transportError(err);
        }
    }

    async checkBalance() {
        try {
            const res = await axios.post(`${this.baseUrl}/balance`, { auth: this.auth }, { timeout: 10000 });
            return { 
                success: true, 
                balance: res.data?.balance || 0,
                raw: res.data
            };
        } catch (err) {
            return { success: false, balance: 0, message: err.message };
        }
    }

    mapResponse(data) {
        if (!data || typeof data !== 'object') {
            return {
                success: false,
                status: 'unknown',
                outcome: PROVIDER_OUTCOMES.UNKNOWN,
                message: 'Invalid response from provider',
                raw: data,
            };
        }
        const providerStatus = typeof data.status === 'string' ? data.status.toLowerCase().trim() : '';
        const providerCode = data.code === undefined || data.code === null ? '' : String(data.code).trim();
        const signals = new Set();

        if (SUCCESS_STATUSES.has(providerStatus)) signals.add(PROVIDER_OUTCOMES.SUCCESS);
        if (PENDING_STATUSES.has(providerStatus)) signals.add(PROVIDER_OUTCOMES.PENDING);
        if (FAILURE_STATUSES.has(providerStatus)) signals.add(PROVIDER_OUTCOMES.DEFINITIVE_FAILURE);
        if (SUCCESS_CODES.has(providerCode)) signals.add(PROVIDER_OUTCOMES.SUCCESS);
        if (PENDING_CODES.has(providerCode)) signals.add(PROVIDER_OUTCOMES.PENDING);
        if (FAILURE_CODES.has(providerCode)) signals.add(PROVIDER_OUTCOMES.DEFINITIVE_FAILURE);

        const outcome = signals.size === 1
            ? [...signals][0]
            : PROVIDER_OUTCOMES.UNKNOWN;
        const isSuccess = outcome === PROVIDER_OUTCOMES.SUCCESS;
        const isPending = outcome === PROVIDER_OUTCOMES.PENDING;
        const isDefinitiveFailure = outcome === PROVIDER_OUTCOMES.DEFINITIVE_FAILURE;
        const fulfillment = normalizeFulfillment(data);
        return {
            success: isSuccess,
            status: isSuccess ? 'success' : isPending ? 'pending' : isDefinitiveFailure ? 'failed' : 'unknown',
            outcome,
            message: data.message || (isSuccess ? 'Success' : 'Request failed'),
            transactionId: data.transactionId || data.requestId,
            token: fulfillment.items[0]?.code,
            fulfillment,
            raw: data
        };
    }
}

module.exports = Vas2NetsAdapter;
