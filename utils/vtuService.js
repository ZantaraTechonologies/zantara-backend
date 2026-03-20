/**
 * BACKWARD COMPATIBILITY LAYER
 * This file now delegates all calls to the ProviderService and standardized adapters.
 * This prevents breaking existing controllers while we migrate them to use services directly.
 */
const providerService = require('../services/provider.service');
const vtpassAdapter = require('../adapters/vtpass.adapter');

const sendAirtimeRequest = async (data) => providerService.purchaseAirtime(data);
const sendDataPurchase = async (data) => providerService.purchaseData(data);
const payBillToProvider = async (data) => providerService.purchaseElectricity(data);
const sendCableRecharge = async (data) => providerService.purchaseCable(data);
const fetchExamPin = async (data) => providerService.purchaseExamPin(data);
const queryTransaction = async (refId) => providerService.queryTransaction(refId);

/** Fetch service variations (data plans, cable packages, etc.) from VTPass */
const fetchPlans = async (serviceID) => {
    return vtpassAdapter.fetchVariations(serviceID);
};

/** Verify a meter number, smartcard, or account number via VTPass */
const verifyMeterWithProvider = async ({ billersCode, serviceID, type }) => {
    return vtpassAdapter.verifyMerchant({ billersCode, serviceID, type });
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