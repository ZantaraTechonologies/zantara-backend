/**
 * BACKWARD COMPATIBILITY LAYER
 * This file now delegates all calls to the ProviderService and standardized adapters.
 * This prevents breaking existing controllers while we migrate them to use services directly.
 */
const providerService = require('../services/provider.service');

const sendAirtimeRequest = async (data) => providerService.purchaseAirtime(data);
const sendDataPurchase = async (data) => providerService.purchaseData(data);
const payBillToProvider = async (data) => providerService.purchaseElectricity(data);
const sendCableRecharge = async (data) => providerService.purchaseCable(data);
const fetchExamPin = async (data) => providerService.purchaseExamPin(data);
const queryTransaction = async (refId) => providerService.queryTransaction(refId);

// Plans and Meter verification still handled here or moved if provider-specific
const axios = require('axios');
const fetchPlans = async (network) => {
    const VTU_URL = `${process.env.VTU_API_URI}/service-variations?serviceID=${network}`
    const res = await axios.get(VTU_URL, {
        auth: { username: process.env.VTU_USERNAME, password: process.env.VTU_PASSWORD }
    });
    return res.data;
}

const verifyMeterWithProvider = async ({ billersCode, serviceID, type }) => {
    const URL = `${process.env.VTU_API_URI}/merchant-verify`
    const res = await axios.post(URL, {
        billersCode,
        serviceID,
        type
    }, {
        auth: { 
            username: process.env.VTU_USERNAME, 
            password: process.env.VTU_PASSWORD 
        }
    });
    return res.data;
}

module.exports = {
    sendAirtimeRequest,
    sendDataPurchase,
    fetchPlans,
    verifyMeterWithProvider,
    payBillToProvider,
    queryTransaction,
    sendCableRecharge,
    fetchExamPin
}