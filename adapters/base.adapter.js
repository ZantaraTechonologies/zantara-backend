class BaseAdapter {
    constructor(config = {}) {
        this.config = config;
        // Normalize baseUrl by removing any trailing slashes to prevent //path errors
        this.baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
        this.apiKey = config.apiKey;
        this.secretKey = config.secretKey;
        this.publicKey = config.publicKey;
        this.metadata = config.metadata || {};
    }

    async purchaseAirtime(data) { throw new Error('Not implemented'); }
    async purchaseData(data) { throw new Error('Not implemented'); }
    async purchaseElectricity(data) { throw new Error('Not implemented'); }
    async purchaseCable(data) { throw new Error('Not implemented'); }
    async purchaseExamPin(data) { throw new Error('Not implemented'); }
    async queryTransaction(refId) { throw new Error('Not implemented'); }
    
    /** Check balance for this provider */
    async checkBalance() { throw new Error('Not implemented'); }
}

module.exports = BaseAdapter;
