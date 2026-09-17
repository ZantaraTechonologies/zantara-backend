const PricingRule = require('../models/PricingRule');
const Service = require('../models/Service');
const { resolvePinQuantity } = require('../utils/pinQuantity');

/**
 * Service responsible for resolving the sale price of a service based on layered rules.
 */
class PricingService {
    /**
     * Resolves the final pricing for a transaction.
     * @param {Object} user - The user making the purchase.
     * @param {Object} service - The normalized Service object.
     * @param {Object} providerOffer - The selected ProviderOffer.
     * @param {number} requestedAmount - For `pin` this is the UNIT (per-card) face value;
     *                                    for other categories it is the total request amount.
     * @param {*} [quantityArg] - PIN batch size (cards). Absent defaults to 1.
     * @returns {Promise<Object>} - Pricing breakdown (totals for `pin`, unchanged for others).
     */
    async resolvePricing(user, service, providerOffer, requestedAmount, quantityArg) {
        const isPin = service.category === 'pin';
        const quantity = isPin ? resolvePinQuantity(quantityArg) : 1;

        // For airtime, the cost is the requested face value. For data, it's the fixed plan cost.
        const costPrice = (service.category === 'airtime' || service.category === 'electricity') 
            ? Number(requestedAmount) 
            : providerOffer.costPrice;
            
        // Priority: Explicit Role (agent, admin, etc.) > AccountType (reseller, retail)
        let userRole = 'all';
        if (user) {
            const rolesArray = Array.isArray(user.roles) ? user.roles : [];
            const allRoles = new Set([user.role, ...rolesArray].filter(Boolean));
            
            // Prioritize agent if present in any role field
            if (allRoles.has('agent')) {
                userRole = 'agent';
            } else if (user.role && user.role !== 'user') {
                userRole = user.role;
            } else {
                userRole = user.accountType || 'retail';
            }
        }

        // 1. Find the best applicable rule (priority-layered)
        const rule = await this._findBestRule(service, userRole);

        let salePrice = costPrice; 
        let markupValue = 0;
        let markupType = 'none';

        if (rule) {
            markupType = rule.markupType;
            markupValue = rule.markupValue;

            if (rule.markupType === 'fixed') {
                salePrice = costPrice + rule.markupValue;
            } else if (rule.markupType === 'percent') {
                salePrice = costPrice * (1 + (rule.markupValue / 100));
            }
        } else {
            // Fallback: If no rule, apply a safe system default (1.5% markup)
            markupType = 'percent_fallback';
            markupValue = 1.5;
            salePrice = costPrice * 1.015;
        }

        const rawSalePrice = salePrice;
        
        // Round only the final chargeable unit salePrice to the nearest whole Naira (NGN)
        const roundedUnitSalePrice = Math.round(salePrice);
        const profit = roundedUnitSalePrice - costPrice;

        // Calculate "Market Reference Price" (SRP) per unit
        // If the service has a suggestedRetailPrice (SRP), use it as the benchmark.
        // Otherwise, fall back to what a standard retail user would pay.
        let referencePrice = service.suggestedRetailPrice || roundedUnitSalePrice;
        
        if (!service.suggestedRetailPrice || service.suggestedRetailPrice <= costPrice) {
            const retailRule = await this._findBestRule(service, 'retail');
            let retailMarkup = costPrice * 0.015; // fallback
            if (retailRule) {
                retailMarkup = retailRule.markupType === 'fixed' 
                    ? retailRule.markupValue 
                    : (costPrice * (retailRule.markupValue / 100));
            }
            referencePrice = Math.round(costPrice + retailMarkup);
        }

        // A PIN service is a fixed-cost UNIT: totalProviderCost = unitCost * qty and
        // totalSalePrice = unitSalePrice * qty. Non-PIN categories are already totalled
        // by the caller, so quantity is always 1 for them.
        const totalBaseCostPrice = costPrice * quantity;
        const totalRawSalePrice = rawSalePrice * quantity;
        const totalSalePrice = roundedUnitSalePrice * quantity;
        const totalReferencePrice = referencePrice * quantity;

        // The savings is what the user is gaining compared to the market/standard price
        const savings = Math.max(0, totalReferencePrice - totalSalePrice);

        return {
            baseCostPrice: totalBaseCostPrice,
            rawSalePrice: totalRawSalePrice,
            salePrice: totalSalePrice,
            retailPrice: totalReferencePrice, // Renamed internally to referencePrice but kept as retailPrice for API compatibility
            savings: savings,
            profit: profit * quantity,
            quantity: quantity,
            appliedPricingRuleId: rule ? rule._id : null,
            markupType: markupType,
            markupValue: markupValue,
            userRole: userRole
        };
    }

    /**
     * Finds the best PricingRule by traversing the hierarchy.
     * Order: Service > ServiceType > ServiceCategory > Global
     * Within each level, it prefers specific role over 'all', then higher priority.
     */
    async _findBestRule(service, userRole) {
        const targets = [
            { type: 'service', id: service._id },
            { type: 'identity', id: service.identityId },
            { type: 'service_type', id: service.typeId },
            { type: 'category', id: service.categoryId },
            { type: 'global', id: null }
        ];

        for (const target of targets) {
            if (target.type !== 'global' && !target.id) continue;

            const query = {
                targetType: target.type,
                targetId: target.id,
                userRole: { $in: [userRole, 'all'] },
                status: true
            };

            const rules = await PricingRule.find(query).sort({ priority: -1 });

            // Hardening: Find the exact role match first, then fall back to 'all'
            const specificRule = rules.find(r => r.userRole === userRole);
            if (specificRule) return specificRule;

            const globalRule = rules.find(r => r.userRole === 'all');
            if (globalRule) return globalRule;
        }

        return null;
    }
}

module.exports = new PricingService();
