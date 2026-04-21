const axios = require('axios');
const BaseAdapter = require('./base.adapter');

/**
 * Universal Adapter
 * A "One-size-fits-most" adapter that uses database metadata for field mapping.
 * Metadata structure example:
 * {
 *   "purchaseUrl": "https://api.dorosub.com/buy",
 *   "balanceUrl": "https://api.dorosub.com/user",
 *   "method": "POST",
 *   "authHeaderName": "Authorization",
 *   "authHeaderValue": "Token {{apiKey}}",
 *   "fieldMap": {
 *      "phone": "mobile_number",
 *      "amount": "amount",
 *      "serviceID": "network",
 *      "variation_code": "plan_id"
 *   },
 *   "successPath": "status",
 *   "successValue": "success"
 * }
 */
class UniversalAdapter extends BaseAdapter {
    constructor(config) {
        super(config);
    }

    /** Replaces {{placeholder}} in string with value from context */
    _resolveTemplate(template, context) {
        if (!template || typeof template !== 'string') return template;
        return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
            return context[key] !== undefined ? context[key] : (this[key] || match);
        });
    }

    _buildHeaders() {
        const headers = { 'Content-Type': 'application/json' };
        if (this.metadata.authHeaderName && this.metadata.authHeaderValue) {
            headers[this.metadata.authHeaderName] = this._resolveTemplate(this.metadata.authHeaderValue, {});
        }
        return headers;
    }

    /** 
     * Resolves an endpoint URL. 
     * If metadata has a full URL, use it. 
     * If metadata has a relative path (starts with /), join with baseUrl.
     * Otherwise fallback to defaultPath joined with baseUrl.
     */
    _resolveUrl(key, defaultPath, context = {}) {
        let path = this.metadata[key];
        
        // If nothing in metadata, use the default
        if (!path) {
            path = defaultPath;
        }

        // Resolve any {{placeholders}} in the path
        path = this._resolveTemplate(path, context);

        // If it's already a full URL, return it
        if (path.startsWith('http')) {
            return path;
        }

        // Otherwise, join with baseUrl (ensuring proper slashes)
        const base = this.baseUrl.replace(/\/+$/, '');
        const relative = path.startsWith('/') ? path : `/${path}`;
        return `${base}${relative}`;
    }

    async _processRequest(data) {
        try {
            const url = this._resolveUrl('purchaseUrl', '', data);
            const method = (this.metadata.method || 'POST').toUpperCase();
            
            // Build payload based on fieldMap
            const payload = {};
            if (this.metadata.fieldMap) {
                Object.entries(this.metadata.fieldMap).forEach(([internalKey, externalKey]) => {
                    payload[externalKey] = data[internalKey];
                });
            } else {
                Object.assign(payload, data);
            }

            const options = {
                method,
                url,
                headers: this._buildHeaders(),
                timeout: 30000
            };

            if (method === 'POST') options.data = payload;
            else options.params = payload;

            const res = await axios(options);
            return this.mapResponse(res.data);
        } catch (err) {
            return { 
                success: false, 
                status: 'failed', 
                message: err.response?.data?.message || err.message,
                raw: err.response?.data 
            };
        }
    }

    async purchaseAirtime(data) { return this._processRequest(data); }
    async purchaseData(data) { return this._processRequest(data); }
    async purchaseElectricity(data) { return this._processRequest(data); }
    async purchaseCable(data) { return this._processRequest(data); }
    async purchaseExamPin(data) { return this._processRequest(data); }

    async checkBalance() {
        try {
            const url = this._resolveUrl('balanceUrl', '/balance');
            const method = (this.metadata.balanceMethod || 'GET').toUpperCase();
            
            const options = {
                method,
                url,
                headers: this._buildHeaders(),
                timeout: 10000
            };

            const res = await axios(options);
            
            // Flexible balance extraction
            const data = res.data;
            const balancePath = this.metadata.balancePath || 'balance';
            // Simple helper to get nested keys if needed (e.g. "user.wallet.balance")
            const balance = balancePath.split('.').reduce((obj, key) => obj?.[key], data) || 0;
            
            return {
                success: true, 
                balance: Number(balance),
                raw: data
            };
        } catch (err) {
            return { success: false, balance: 0, message: err.message };
        }
    }

    async queryTransaction(request_id) {
        try {
            const url = this._resolveUrl('queryUrl', '/requery', { request_id });
            const method = (this.metadata.queryMethod || 'POST').toUpperCase();
            
            const options = {
                method,
                url,
                headers: this._buildHeaders(),
                timeout: 15000
            };

            const payload = { [this.metadata.fieldMap?.request_id || 'request_id']: request_id };
            if (method === 'POST') options.data = payload;
            else options.params = payload;

            const res = await axios(options);
            return this.mapResponse(res.data);
        } catch (err) {
            return { success: false, status: 'failed', message: err.message };
        }
    }

    /**
     * Standardized Discovery for Universal Providers
     * Metadata requirements:
     * - variationsUrl: URL to fetch plans (can include {{serviceID}})
     * - variationsPath: path to the array in response (e.g. "content.variations")
     * - variationFieldMap: { variationCode: "id", name: "name", amount: "amount" }
     */
    async fetchVariations(serviceID) {
        try {
            const url = this._resolveUrl('variationsUrl', `/service-variations?serviceID=${serviceID}`, { serviceID });
            const options = {
                method: 'GET',
                url,
                headers: this._buildHeaders(),
                timeout: 15000
            };

            const res = await axios(options);
            const data = res.data;

            // Extract the list
            const path = this.metadata.variationsPath || 'content.variations';
            const rawList = path.split('.').reduce((obj, key) => obj?.[key], data) || [];

            if (!Array.isArray(rawList)) {
                return { success: false, message: 'Invalid variation list format from provider' };
            }

            // Map fields
            const fieldMap = this.metadata.variationFieldMap || { 
                variationCode: 'variation_code', 
                name: 'name', 
                amount: 'variation_amount' 
            };

            const variations = rawList.map(v => ({
                variationCode: v[fieldMap.variationCode] || v.variation_code,
                name: v[fieldMap.name] || v.name,
                amount: Number(v[fieldMap.amount] || v.variation_amount || 0)
            }));

            return { success: true, variations, raw: data };
        } catch (err) {
            return { success: false, message: err.message };
        }
    }

    mapResponse(data) {
        const successPath = this.metadata.successPath || 'status';
        const successValue = this.metadata.successValue || 'success';
        
        // Deep find for success key
        const actualValue = data[successPath];
        const isSuccess = String(actualValue).toLowerCase() === String(successValue).toLowerCase();

        return {
            success: isSuccess,
            status: isSuccess ? 'success' : 'failed',
            message: data.message || data.response_description || (isSuccess ? 'Processed' : 'Failed'),
            transactionId: data.reference || data.transactionId || data.id,
            token: data.token || data.purchased_code || data.pin,
            raw: data
        };
    }
}

module.exports = UniversalAdapter;
