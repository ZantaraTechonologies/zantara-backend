const Setting = require('../models/Setting');

/**
 * Calculate the final price for a service variation
 * @param {string[]} roles - User roles array (e.g. ['user', 'reseller'])
 * @param {number} baseAmount - The base price or amount of the service
 * @returns {number} - The discounted price for agents, or base price for users
 */
const calculateServicePrice = async (roles, baseAmount) => {
    // Check if user has 'reseller' or 'agent' role
    const isAgent = Array.isArray(roles) && (roles.includes('reseller') || roles.includes('agent'));

    if (!isAgent) return baseAmount;

    // Fetch Agent Discount Percentage
    const discountSetting = await Setting.findOne({ key: 'agent_discount_percentage' });
    const discount = discountSetting ? Number(discountSetting.value) : 1; // Default 1% for resellers if not set

    if (discount <= 0) return baseAmount;

    const discountAmount = (discount / 100) * baseAmount;
    return baseAmount - discountAmount;
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
