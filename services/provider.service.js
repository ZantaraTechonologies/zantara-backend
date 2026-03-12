const vas2netsAdapter = require('../adapters/vas2nets.adapter');

class ProviderService {
    constructor() {
        // In a more complex setup, this could be dynamic based on settings or failover logic
        this.primaryAdapter = vas2netsAdapter;
    }

    async purchaseAirtime(data) {
        return this.primaryAdapter.purchaseAirtime(data);
    }

    async purchaseData(data) {
        return this.primaryAdapter.purchaseData(data);
    }

    async purchaseElectricity(data) {
        return this.primaryAdapter.purchaseElectricity(data);
    }

    async purchaseCable(data) {
        return this.primaryAdapter.purchaseCable(data);
    }

    async purchaseExamPin(data) {
        return this.primaryAdapter.purchaseExamPin(data);
    }

    async queryTransaction(refId) {
        return this.primaryAdapter.queryTransaction(refId);
    }
}

module.exports = new ProviderService();
