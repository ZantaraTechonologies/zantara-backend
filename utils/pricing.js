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
    const discount = discountSetting ? Number(discountSetting.value) : 0; // Default 0%

    if (discount <= 0) return baseAmount;

    const discountAmount = (discount / 100) * baseAmount;
    return baseAmount - discountAmount;
};

module.exports = { calculateServicePrice };
