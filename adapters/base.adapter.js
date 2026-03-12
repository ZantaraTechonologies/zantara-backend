class BaseAdapter {
    async purchaseAirtime(data) { throw new Error('Not implemented'); }
    async purchaseData(data) { throw new Error('Not implemented'); }
    async purchaseElectricity(data) { throw new Error('Not implemented'); }
    async purchaseCable(data) { throw new Error('Not implemented'); }
    async purchaseExamPin(data) { throw new Error('Not implemented'); }
    async queryTransaction(refId) { throw new Error('Not implemented'); }
}

module.exports = BaseAdapter;
