const axios = require('axios');
const BaseAdapter = require('./base.adapter');

class Vas2NetsAdapter extends BaseAdapter {
    constructor() {
        super();
        this.baseUrl = process.env.VTU_API_URI;
        this.auth = {
            username: process.env.VTU_USERNAME,
            password: process.env.VTU_PASSWORD
        };
    }

    async purchaseAirtime({ request_id, serviceID, phone, amount }) {
        try {
            const res = await axios.post(`${this.baseUrl}/pay`, { auth: this.auth }, {
                request_id, serviceID, phone, amount
            });
            return this.mapResponse(res.data);
        } catch (err) {
            return { status: 'failed', message: err.message };
        }
    }

    async purchaseData({ request_id, serviceID, billersCode, variation_code, phone }) {
        try {
            const res = await axios.post(`${this.baseUrl}/pay`, { auth: this.auth }, {
                request_id, serviceID, billersCode, variation_code, phone
            });
            return this.mapResponse(res.data);
        } catch (err) {
            return { status: 'failed', message: err.message };
        }
    }

    async purchaseElectricity({ request_id, serviceID, billersCode, variation_code, amount, phone }) {
        try {
            const res = await axios.post(`${this.baseUrl}/pay`, { auth: this.auth }, {
                request_id, serviceID, billersCode, variation_code, amount, phone
            });
            return this.mapResponse(res.data);
        } catch (err) {
            return { status: 'failed', message: err.message };
        }
    }

    async purchaseCable({ request_id, serviceID, billersCode, variation_code, amount }) {
        try {
            const res = await axios.post(`${this.baseUrl}/pay`, { auth: this.auth }, {
                request_id, serviceID, billersCode, variation_code, amount
            });
            return this.mapResponse(res.data);
        } catch (err) {
            return { status: 'failed', message: err.message };
        }
    }

    async purchaseExamPin({ request_id, variation_code, amount, quantity, phone }) {
        try {
            const res = await axios.post(`${this.baseUrl}/pay`, { auth: this.auth }, {
                request_id, variation_code, amount, quantity, phone
            });
            return this.mapResponse(res.data);
        } catch (err) {
            return { status: 'failed', message: err.message };
        }
    }

    async queryTransaction(request_id) {
        try {
            const res = await axios.post(`${this.baseUrl}/requery`, { auth: this.auth }, { request_id });
            return this.mapResponse(res.data);
        } catch (err) {
            return { status: 'failed', message: err.message };
        }
    }

    mapResponse(data) {
        // Standardize response to { success: boolean, status: string, message: string, data: object }
        const isSuccess = data.status === 'success' || data.code === '000';
        return {
            success: isSuccess,
            status: isSuccess ? 'success' : 'failed',
            message: data.message || (isSuccess ? 'Success' : 'Request failed'),
            raw: data
        };
    }
}

module.exports = new Vas2NetsAdapter();
