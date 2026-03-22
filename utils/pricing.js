const Setting = require('../models/Setting');

/**
 * Calculate the final price for a service variation
 * @param {Object} user - Full User object
 * @param {number} baseAmount - Standard selling price
 * @returns {number} - The discounted price for agents, or base price for users
 */
const calculateServicePrice = async (user, baseAmount) => {
    if (!user) return baseAmount;

    // Check if user is an agent
    const isAgent = user.role === 'agent' || (Array.isArray(user.roles) && user.roles.includes('agent'));

    if (!isAgent) return baseAmount;

    // Fetch Global Agent Discount Setting
    const discountSetting = await Setting.findOne({ key: 'defaultAgentDiscountRate' });
    const globalRate = discountSetting ? Number(discountSetting.value) : 0;

    // Resolve Final Discount Rate
    // Logic: User Override > Global Default > 0% Fallback
    const rate = (user.agentDiscountRate !== undefined && user.agentDiscountRate !== null)
        ? user.agentDiscountRate
        : globalRate;

    if (rate <= 0) return baseAmount;

    // Apply discount
    const discountedPrice = baseAmount * (1 - rate);
    return Math.round(discountedPrice * 100) / 100; // Round to 2 decimal places
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
