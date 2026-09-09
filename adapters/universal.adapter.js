const axios = require('axios');
const BaseAdapter = require('./base.adapter');

/**
 * Safely extracts a value from an object using a dot-separated path (e.g. 'data.user.balance').
 * Avoids any eval or arbitrary code execution.
 */
function getByDotPath(obj, path) {
    if (!obj || !path || typeof path !== 'string') return undefined;
    const parts = path.split('.').map(p => p.trim()).filter(Boolean);
    let curr = obj;
    for (const part of parts) {
        if (curr === null || curr === undefined || typeof curr !== 'object') {
            return undefined;
        }
        curr = curr[part];
    }
    return curr;
}

/**
 * Universal Adapter
 * A "One-size-fits-most" adapter that uses database metadata for field mapping and endpoints.
 */
class UniversalAdapter extends BaseAdapter {
    constructor(config) {
        super(config);
    }

    /** Replaces {{placeholder}} in string with value from context or instance properties */
    _resolveTemplate(template, context = {}) {
        if (!template || typeof template !== 'string') return template;
        return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
            if (context[key] !== undefined) return context[key];
            if (this[key] !== undefined) return this[key];
            return match;
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
     * Resolves an endpoint URL with fallback priority.
     * key: specific metadata key (e.g. 'dataPurchaseUrl')
     * fallbackKey: secondary metadata key (e.g. 'purchaseUrl')
     * defaultPath: default path if neither key exists (e.g. '')
     */
    _resolveUrlWithFallback(key, fallbackKey, defaultPath, context = {}) {
        let path = (key && this.metadata[key]) || (fallbackKey && this.metadata[fallbackKey]) || defaultPath;
        if (!path) path = '';

        // Resolve any {{placeholders}} in the path
        path = this._resolveTemplate(path, context);

        // If it's already a full URL, return it
        if (path.startsWith('http://') || path.startsWith('https://')) {
            return path;
        }

        // Otherwise, join with baseUrl
        const base = this.baseUrl.replace(/\/+$/, '');
        const relative = path.startsWith('/') ? path : `/${path}`;
        return `${base}${relative}`;
    }

    _resolveUrl(key, defaultPath, context = {}) {
        return this._resolveUrlWithFallback(key, null, defaultPath, context);
    }

    /**
     * Resolves HTTP method with fallback.
     * key: e.g. 'dataMethod'
     * fallbackKey: e.g. 'method'
     * defaultMethod: e.g. 'POST'
     */
    _resolveMethod(key, fallbackKey, defaultMethod = 'POST') {
        const method = (key && this.metadata[key]) || (fallbackKey && this.metadata[fallbackKey]) || defaultMethod;
        return String(method).toUpperCase();
    }

    /**
     * Generic request processor supporting category endpoint & method resolution.
     */
    async _processRequest(data, category = null) {
        try {
            const endpointKey = category ? `${category}PurchaseUrl` : 'purchaseUrl';
            const methodKey = category ? `${category}Method` : 'method';
            const fieldMapKey = category ? `${category}FieldMap` : 'fieldMap';

            const url = this._resolveUrlWithFallback(endpointKey, 'purchaseUrl', '', data);
            const method = this._resolveMethod(methodKey, 'method', 'POST');
            
            // Build payload based on category-specific field map or global fieldMap
            const activeFieldMap = (category && this.metadata[fieldMapKey]) || this.metadata.fieldMap;
            const payload = {};
            if (activeFieldMap && typeof activeFieldMap === 'object') {
                Object.entries(activeFieldMap).forEach(([internalKey, externalKey]) => {
                    if (data[internalKey] !== undefined) {
                        payload[externalKey] = data[internalKey];
                    }
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

            if (['POST', 'PUT', 'PATCH'].includes(method)) {
                options.data = payload;
            } else {
                options.params = payload;
            }

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

    async purchaseAirtime(data) { return this._processRequest(data, 'airtime'); }
    async purchaseData(data) { return this._processRequest(data, 'data'); }
    async purchaseElectricity(data) { return this._processRequest(data, 'electricity'); }
    async purchaseCable(data) { return this._processRequest(data, 'cable'); }
    async purchaseExamPin(data) { return this._processRequest(data, 'exam'); }

    async checkBalance() {
        try {
            const url = this._resolveUrl('balanceUrl', '/balance');
            const method = this._resolveMethod('balanceMethod', null, 'GET');
            
            const options = {
                method,
                url,
                headers: this._buildHeaders(),
                timeout: 10000
            };

            const res = await axios(options);
            const data = res.data;

            // Dot-path balance extraction
            const balancePath = this.metadata.balancePath || 'balance';
            const extractedBalance = getByDotPath(data, balancePath);
            const balanceValue = extractedBalance !== undefined ? extractedBalance : data[balancePath];
            const balance = Number(balanceValue) || 0;
            
            return {
                success: true, 
                balance,
                raw: data
            };
        } catch (err) {
            return { success: false, balance: 0, message: err.response?.data?.message || err.message };
        }
    }

    async queryTransaction(request_id) {
        try {
            const url = this._resolveUrl('queryUrl', '/requery', { request_id });
            const method = this._resolveMethod('queryMethod', null, 'POST');
            
            const options = {
                method,
                url,
                headers: this._buildHeaders(),
                timeout: 15000
            };

            const reqKey = this.metadata.fieldMap?.request_id || 'request_id';
            const payload = { [reqKey]: request_id };

            if (['POST', 'PUT', 'PATCH'].includes(method)) {
                options.data = payload;
            } else {
                options.params = payload;
            }

            const res = await axios(options);
            return this.mapResponse(res.data);
        } catch (err) {
            return { success: false, status: 'failed', message: err.response?.data?.message || err.message };
        }
    }

    /**
     * Standardized Variations Discovery for Universal Providers
     */
    async fetchVariations(serviceID) {
        try {
            const url = this._resolveUrl('variationsUrl', `/service-variations?serviceID=${serviceID}`, { serviceID });
            const method = this._resolveMethod('variationsMethod', null, 'GET');

            const options = {
                method,
                url,
                headers: this._buildHeaders(),
                timeout: 15000
            };

            const res = await axios(options);
            const data = res.data;

            // Extract the list using safe dot-path
            const path = this.metadata.variationsPath || 'content.variations';
            const rawList = getByDotPath(data, path) || [];

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
            return { success: false, message: err.response?.data?.message || err.message };
        }
    }

    /**
     * Customer / Merchant verification for bills, meters, smartcards
     */
    async verifyMerchant(data) {
        if (!this.metadata.verifyUrl) {
            return { success: false, message: 'Customer verification not configured for this provider' };
        }

        try {
            const url = this._resolveUrl('verifyUrl', '', data);
            const method = this._resolveMethod('verifyMethod', null, 'POST');

            const payload = {};
            if (this.metadata.fieldMap && typeof this.metadata.fieldMap === 'object') {
                Object.entries(this.metadata.fieldMap).forEach(([internalKey, externalKey]) => {
                    if (data[internalKey] !== undefined) {
                        payload[externalKey] = data[internalKey];
                    }
                });
            } else {
                Object.assign(payload, data);
            }

            const options = {
                method,
                url,
                headers: this._buildHeaders(),
                timeout: 15000
            };

            if (['POST', 'PUT', 'PATCH'].includes(method)) {
                options.data = payload;
            } else {
                options.params = payload;
            }

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

    /**
     * Normalized response mapping following Zantara provider response structure
     */
    mapResponse(data) {
        if (!data || typeof data !== 'object') {
            return {
                success: false,
                status: 'failed',
                message: 'Invalid response from provider',
                raw: data
            };
        }

        const successPath = this.metadata.successPath || 'status';
        const expectedSuccessValue = this.metadata.successValue !== undefined && this.metadata.successValue !== ''
            ? String(this.metadata.successValue).toLowerCase()
            : 'success';

        // Safe dot-path extraction for success
        const extractedSuccess = getByDotPath(data, successPath);
        const actualSuccess = extractedSuccess !== undefined ? extractedSuccess : data[successPath];

        let isSuccess = false;
        if (actualSuccess !== undefined && actualSuccess !== null) {
            isSuccess = String(actualSuccess).toLowerCase() === expectedSuccessValue;
        }

        // Status
        let status = isSuccess ? 'success' : 'failed';
        if (this.metadata.statusPath) {
            const extractedStatus = getByDotPath(data, this.metadata.statusPath);
            if (extractedStatus !== undefined && extractedStatus !== null) {
                status = String(extractedStatus);
            }
        }

        // Message
        let message;
        if (this.metadata.messagePath) {
            const extractedMsg = getByDotPath(data, this.metadata.messagePath);
            if (extractedMsg !== undefined && extractedMsg !== null) {
                message = typeof extractedMsg === 'object' ? JSON.stringify(extractedMsg) : String(extractedMsg);
            }
        }
        if (!message) {
            message = data.message || data.response_description || data.msg || (isSuccess ? 'Processed' : 'Failed');
        }

        // Transaction ID
        let transactionId;
        if (this.metadata.transactionIdPath) {
            const extractedTx = getByDotPath(data, this.metadata.transactionIdPath);
            if (extractedTx !== undefined && extractedTx !== null) {
                transactionId = String(extractedTx);
            }
        }
        if (!transactionId) {
            transactionId = data.reference || data.transactionId || data.id || data.order_id || data.request_id;
        }

        // Token (electricity / pin)
        const token = data.token || data.purchased_code || data.pin || data.token_code || data.data?.token || data.data?.pin;

        return {
            success: isSuccess,
            status,
            message: String(message),
            transactionId: transactionId ? String(transactionId) : undefined,
            token: token ? String(token) : undefined,
            raw: data
        };
    }
}

module.exports = UniversalAdapter;
