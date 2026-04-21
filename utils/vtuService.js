/**
 * BACKWARD COMPATIBILITY LAYER
 * This file now delegates all calls to the ProviderService and standardized adapters.
 * This prevents breaking existing controllers while we migrate them to use services directly.
 */
const providerService = require('../services/provider.service');

const sendAirtimeRequest = async (data, provider) => providerService.purchaseAirtime(data, provider);
const sendDataPurchase = async (data, provider) => providerService.purchaseData(data, provider);
const payBillToProvider = async (data, provider) => providerService.purchaseElectricity(data, provider);
const sendCableRecharge = async (data, provider) => providerService.purchaseCable(data, provider);
const fetchExamPin = async (data, provider) => providerService.purchaseExamPin(data, provider);
const queryTransaction = async (refId, provider) => providerService.queryTransaction(refId, provider);

/** Fetch service variations (data plans, cable packages, etc.) from provider */
const fetchPlans = async (serviceID, provider) => {
    return providerService.fetchVariations(serviceID, provider);
};

/** Verify a meter number, smartcard, or account number via provider */
const verifyMeterWithProvider = async (data, provider) => {
    return providerService.verifyMerchant(data, provider);
};

module.exports = {
    sendAirtimeRequest,
    sendDataPurchase,
    fetchPlans,
    verifyMeterWithProvider,
    payBillToProvider,
    queryTransaction,
    sendCableRecharge,
    fetchExamPin
};