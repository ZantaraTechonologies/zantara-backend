const axios = require('axios');
const BaseAdapter = require('./base.adapter');

/**
 * VTPass Adapter
 * Docs: https://www.vtpass.com/documentation
 * Auth: Basic Auth (API Key : Secret Key)
 */
class VTPassAdapter extends BaseAdapter {
    constructor(config) {
        super(config);
    }

    /** Build VTPass-required request headers from injected config */
    _authHeaders() {
        const headers = {
            'Content-Type': 'application/json',
        };
        
        if (this.apiKey) headers['api-key'] = this.apiKey;
        if (this.secretKey) headers['secret-key'] = this.secretKey;
        if (this.publicKey) headers['public-key'] = this.publicKey;
        
        return headers;
    }

    /** POST to /pay */
    async _pay(payload) {
        const res = await axios.post(`${this.baseUrl}/pay`, payload, {
            headers: this._authHeaders(),
            timeout: 30000,
        });
        return res.data;
    }

    /** GET all top-level categories */
    async fetchCategories() {
        const res = await axios.get(`${this.baseUrl}/service-categories`, {
            headers: this._authHeaders(),
            timeout: 15000,
        });
        return res.data;
    }

    /** GET all services (providers) within a category identifier */
    async fetchServicesInCategory(identifier) {
        const res = await axios.get(`${this.baseUrl}/services?identifier=${identifier}`, {
            headers: this._authHeaders(),
            timeout: 15000,
        });
        return res.data;
    }

    /** GET service variations (plan list) */
    async fetchVariations(serviceID) {
        try {
            const res = await axios.get(`${this.baseUrl}/service-variations?serviceID=${serviceID}`, {
                headers: this._authHeaders(),
                timeout: 15000,
            });
            
            // VTPass sometimes uses 'code' and sometimes 'response_description' 
            const code = String(res.data?.code || res.data?.response_description || '');
            const isSuccess = code === '000' || code === '1';

            if (isSuccess) {
                // VTPass has a famous typo in some responses: "varations" instead of "variations"
                const vars = res.data?.content?.variations || res.data?.content?.varations || [];
                
                return {
                    success: true,
                    variations: vars.map(v => ({
                        variationCode: v.variation_code,
                        name: v.name,
                        amount: Number(v.variation_amount)
                    })),
                    raw: res.data
                };
            }
            return { success: false, message: res.data?.response_description || 'Failed to fetch variations' };
        } catch (err) {
            return this._errorResponse(err);
        }
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
            const finalServiceID = (serviceID || '').toLowerCase();
            const raw = await this._pay({ request_id, serviceID: finalServiceID, amount, phone });
            return this.mapResponse(raw);
        } catch (err) {
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

    async purchaseExamPin({ request_id, serviceID, variation_code, amount, quantity, phone, billersCode }) {
        try {
            let finalServiceID = serviceID || (variation_code ? variation_code.split('-')[0] : '');
            if (variation_code && variation_code.startsWith('utme')) {
                finalServiceID = 'jamb';
            }
            
            finalServiceID = finalServiceID.toLowerCase();
            const finalVarCode = (variation_code || '').toLowerCase();
            
            const payload = { 
                request_id, 
                serviceID: finalServiceID, 
                variation_code: finalVarCode, 
                amount, 
                phone 
            };
            
            if (billersCode) payload.billersCode = billersCode;
            if (quantity && finalServiceID !== 'jamb') payload.quantity = quantity;

            const raw = await this._pay(payload);
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

    /** GET vendor API balance */
    async checkBalance() {
        try {
            const url = `${this.baseUrl}/balance`;
            
            // VTPass Balance check strictly requires ONLY api-key and public-key.
            // Sending the secret-key here often causes a 401 on Sandbox.
            const headers = {
                'Content-Type': 'application/json',
                'api-key': this.apiKey,
                'public-key': this.publicKey
            };

            const res = await axios.get(url, {
                headers,
                timeout: 10000,
            });
            
            // In Sandbox, success code is often 1. In Live, it is 000.
            const code = String(res.data?.code || '');
            const isSuccess = code === '000' || code === '1';

            return { 
                success: isSuccess, 
                balance: res.data?.contents?.balance || 0,
                raw: res.data,
                message: res.data?.response_description || res.data?.message
            };
        } catch (err) {
            return this._errorResponse(err);
        }
    }

    // ─────────────────────────────────────────────
    // RESPONSE NORMALIZER
    // ─────────────────────────────────────────────

    mapResponse(data) {
        const code = String(data?.code || '');
        const isSuccess = code === '000';
        const isPending = code === '099';
        const status = isSuccess ? 'success' : isPending ? 'pending' : 'failed';

        const rawToken = data?.purchased_code || data?.token || data?.Pin || (data?.tokens?.[0]);
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
        const body = err?.response?.data;
        const message = body?.response_description || body?.content?.errors?.error || body?.message || err?.message || 'VTPass request failed';
        return { success: false, status: 'failed', message, raw: body || {} };
    }
}

module.exports = VTPassAdapter;
