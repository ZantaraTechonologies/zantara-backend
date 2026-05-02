const Setting = require('../models/Setting');

/**
 * Calculate the final price for a service variation
 * @param {Object} user - Full User object
 * @param {number} baseAmount - Standard selling price
 * @param {number} costPrice - The cost price from the provider
 * @returns {number} - The discounted price for agents, or base price for users
 */
const calculateServicePrice = async (user, baseAmount, costPrice = baseAmount) => {
    // Legacy agentDiscountRate logic removed in favor of Pricing Rules.
    // This fallback now returns the base price.
    return baseAmount;
};

/**
 * Get the wholesale cost of a service from settings or provider mapping
 * @param {string} serviceId 
 * @param {number} amount 
 */
const getProviderCost = async (serviceId, amount) => {
    // For now, assume a global provider margin or check specific service margin setting
    const marginSetting = await Setting.findOne({ key: `margin_${serviceId}` }) || await Setting.findOne({ key: 'default_provider_margin_percentage' });
    const marginPercent = marginSetting ? Number(marginSetting.value) : 2; // Default 2% margin if not found

    return amount * (1 - (marginPercent / 100));
};

module.exports = { calculateServicePrice, getProviderCost };
