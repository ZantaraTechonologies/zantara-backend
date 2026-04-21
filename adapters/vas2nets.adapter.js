const axios = require('axios');
const BaseAdapter = require('./base.adapter');

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
            return { success: false, status: 'failed', message: err.message };
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
            return { success: false, status: 'failed', message: err.message };
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
            return { success: false, status: 'failed', message: err.message };
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
            return { success: false, status: 'failed', message: err.message };
        }
    }

    async purchaseExamPin({ request_id, variation_code, amount, quantity, phone }) {
        try {
            const res = await axios.post(`${this.baseUrl}/pay`, { 
                auth: this.auth,
                request_id, variation_code, amount, quantity, phone
            }, { timeout: 30000 });
            return this.mapResponse(res.data);
        } catch (err) {
            return { success: false, status: 'failed', message: err.message };
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
            return { success: false, status: 'failed', message: err.message };
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
        const isSuccess = data.status === 'success' || data.code === '000';
        return {
            success: isSuccess,
            status: isSuccess ? 'success' : 'failed',
            message: data.message || (isSuccess ? 'Success' : 'Request failed'),
            transactionId: data.transactionId || data.requestId,
            token: data.token || data.purchased_code,
            raw: data
        };
    }
}

module.exports = Vas2NetsAdapter;
