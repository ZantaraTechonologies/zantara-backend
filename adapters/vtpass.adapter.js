const axios = require('axios');
const BaseAdapter = require('./base.adapter');

/**
 * VTPass Adapter
 * Docs: https://www.vtpass.com/documentation
 * Auth: Basic Auth (API Key : Secret Key)
 * Base URLs:
 *   Sandbox: https://sandbox.vtpass.com/api
 *   Live:    https://vtpass.com/api
 */

class VTPassAdapter extends BaseAdapter {
    constructor() {
        super();
    }

    // ── Lazy getters so keys are always read from process.env at request time ──
    get baseUrl() { return process.env.VTU_API_URI || 'https://sandbox.vtpass.com/api'; }
    get apiKey()   { return process.env.VTPASS_API_KEY; }
    get secretKey(){ return process.env.VTPASS_SECRET_KEY; }
    get publicKey(){ return process.env.VTPASS_PUBLIC_KEY; }

    /** Build VTPass-required request headers */
    _authHeaders() {
        console.log('[Adapter: VTPass] Using baseUrl:', this.baseUrl);
        console.log('[Adapter: VTPass] api-key present:', !!this.apiKey);
        console.log('[Adapter: VTPass] secret-key present:', !!this.secretKey);
        console.log('[Adapter: VTPass] public-key present:', !!this.publicKey);
        return {
            'api-key': this.apiKey,
            'secret-key': this.secretKey,
            'public-key': this.publicKey,
            'Content-Type': 'application/json',
        };
    }

    /** POST to /pay */
    async _pay(payload) {
        console.log(`[Adapter: VTPass] -> _pay sending POST to ${this.baseUrl}/pay`);
        console.log(`[Adapter: VTPass] -> _pay payload:`, JSON.stringify(payload));
        const res = await axios.post(`${this.baseUrl}/pay`, payload, {
            headers: this._authHeaders(),
            timeout: 30000,
        });
        console.log(`[Adapter: VTPass] -> _pay received status: ${res.status}`);
        return res.data;
    }

    /** GET service variations (plan list) */
    async fetchVariations(serviceID) {
        const res = await axios.get(`${this.baseUrl}/service-variations?serviceID=${serviceID}`, {
            headers: this._authHeaders(),
            timeout: 15000,
        });
        return res.data;
    }

    /** POST merchant-verify (meter / smartcard / account number) */
    async verifyMerchant({ billersCode, serviceID, type }) {
        const res = await axios.post(`${this.baseUrl}/merchant-verify`, {
            billersCode,
            serviceID,
            type,
        }, {
            headers: this._authHeaders(),
            timeout: 15000,
        });
        return res.data;
    }

    // ─────────────────────────────────────────────
    // PURCHASES
    // ─────────────────────────────────────────────

    async purchaseAirtime({ request_id, serviceID, phone, amount }) {
        try {
            console.log(`[Adapter: VTPass] -> purchaseAirtime called. reqId: ${request_id}, serviceID: ${serviceID}, phone: ${phone}, amount: ${amount}`);
            const finalServiceID = (serviceID || '').toLowerCase();
            const raw = await this._pay({ request_id, serviceID: finalServiceID, amount, phone });
            console.log(`[Adapter: VTPass] -> Raw response from _pay:`, JSON.stringify(raw));
            return this.mapResponse(raw);
        } catch (err) {
            console.error(`[Adapter: VTPass] -> _pay threw error:`, err?.message);
            return this._errorResponse(err);
        }
    }

    async purchaseData({ request_id, serviceID, billersCode, variation_code, phone, amount }) {
        try {
            const finalServiceID = (serviceID || '').toLowerCase();
            const finalVarCode = (variation_code || '').toLowerCase();
            const raw = await this._pay({ request_id, serviceID: finalServiceID, billersCode, variation_code: finalVarCode, phone, amount });
            return this.mapResponse(raw);
        } catch (err) {
            return this._errorResponse(err);
        }
    }

    async purchaseElectricity({ request_id, serviceID, billersCode, variation_code, amount, phone }) {
        try {
            const finalServiceID = (serviceID || '').toLowerCase();
            const finalVarCode = (variation_code || '').toLowerCase();
            const raw = await this._pay({ request_id, serviceID: finalServiceID, billersCode, variation_code: finalVarCode, amount, phone });
            return this.mapResponse(raw);
        } catch (err) {
            return this._errorResponse(err);
        }
    }

    async purchaseCable({ request_id, serviceID, billersCode, variation_code, amount, phone, quantity }) {
        try {
            const finalServiceID = (serviceID || '').toLowerCase();
            const finalVarCode = (variation_code || '').toLowerCase();
            const raw = await this._pay({ request_id, serviceID: finalServiceID, billersCode, variation_code: finalVarCode, amount, phone, quantity });
            return this.mapResponse(raw);
        } catch (err) {
            return this._errorResponse(err);
        }
    }

    async purchaseExamPin({ request_id, serviceID, variation_code, amount, quantity, phone }) {
        try {
            // VTPass Exam Pin: if serviceID is missing, extract it (e.g. 'waec' from 'waec-registration')
            let finalServiceID = serviceID || (variation_code ? variation_code.split('-')[0] : '');
            finalServiceID = finalServiceID.toLowerCase();
            const finalVarCode = (variation_code || '').toLowerCase();

            const raw = await this._pay({ 
                request_id, 
                serviceID: finalServiceID, 
                variation_code: finalVarCode, 
                amount, 
                quantity, 
                phone 
            });
            return this.mapResponse(raw);
        } catch (err) {
            return this._errorResponse(err);
        }
    }

    /** Requery a transaction by request_id */
    async queryTransaction(request_id) {
        try {
            const res = await axios.post(`${this.baseUrl}/requery`, { request_id }, {
                headers: this._authHeaders(),
                timeout: 15000,
            });
            return this.mapResponse(res.data);
        } catch (err) {
            return this._errorResponse(err);
        }
    }

    // ─────────────────────────────────────────────
    // RESPONSE NORMALIZER
    // ─────────────────────────────────────────────

    /**
     * VTPass returns:
     *  { code: '000', response_description: 'TRANSACTION SUCCESSFUL', ... }
     * Success codes: '000'
     * Delivered codes: '099' (still pending)
     */
    mapResponse(data) {
        const code = String(data?.code || '');
        const isSuccess = code === '000';
        const isPending = code === '099';
        const status = isSuccess ? 'success' : isPending ? 'pending' : 'failed';

        // Extract token/PIN from various possible VTPass response fields
        // Electricity: data.purchased_code (e.g. "Token : 1234...") or data.token
        // Exam PINs: data.purchased_code or data.Pin
        const rawToken = data?.purchased_code || data?.token || data?.Pin || (data?.tokens?.[0]);
        // Clean up "Token : " prefix if present
        const cleanToken = typeof rawToken === 'string' ? rawToken.replace(/^(Token|Pin)\s*:\s*/i, '') : rawToken;

        return {
            success: isSuccess,
            status,
            message: data?.response_description || data?.content?.errors?.error || 'Transaction processed',
            transactionId: data?.content?.transactions?.transactionId || data?.requestId,
            token: cleanToken,  
            raw: data,
        };
    }

    _errorResponse(err) {
        const status = err?.response?.status;
        const body = err?.response?.data;
        const message = body?.response_description || body?.message || err?.message || 'VTPass request failed';
        console.error('[VTPass] Error status:', status);
        console.error('[VTPass] Error body:', JSON.stringify(body));
        console.error('[VTPass] Error message:', message);
        return { success: false, status: 'failed', message, raw: body || {} };
    }
}

module.exports = new VTPassAdapter();
