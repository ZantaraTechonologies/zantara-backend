/**
 * VTPass Commission Rates (API Partner Level)
 * Based on the latest commission table provided by Zantara Admin.
 * Rates are stored as decimal for percentage (e.g. 0.034 for 3.4%)
 * or as flat numbers for fixed earnings.
 */
const VTPASS_RATES = {
    // --- AIRTIME & DATA ---
    'mtn-airtime': 0.030,
    'mtn-data': 0.030,
    'airtel-airtime': 0.034,
    'airtel-data': 0.034,
    'glo-airtime': 0.040,
    'glo-data': 0.040,
    'glo-sme-data': 0.040,
    'etisalat-airtime': 0.040, // 9mobile
    'etisalat-data': 0.040,
    
    // --- ELECTRICITY (Fixed IDs for both Sandbox & Prod) ---
    'ikeja-electric': 0.010, // IKEDC
    'eko-electric': 0.010,   // EKEDC
    'abuja-electric': 0.012, // AEDC
    'kano-electric': 0.010,  // KEDCO
    'portharcourt-electric': 0.011, // PHED
    'jos-electric': 0.009,   // JED
    'kaduna-electric': 0.015, // KAEDCO
    'enugu-electric': 0.014, // EEDC
    'benin-electric': 0.015, // BEDC
    'aba-electric': 0.017,   // ABEDC
    'yola-electric': 0.012,  // YEDC
    'ibadan-electric': 0.011, // IBEDC
    'iban-electric': 0.011,   // Alias

    // --- TV SUBSCRIPTION ---
    'dstv': 0.015,
    'gotv': 0.015,
    'startimes': 0.020,
    'showmax': 0.020,
    'smile-direct': 0.050,

    // --- EDUCATION (Fixed Earnings) ---
    'waec': 250,              // WAEC Result Checker
    'waec-registration': 150, // WAEC Registration
    'waec-registration-pin': 150, // Alternate ID
    'jamb': 150,              // JAMB PIN
    'jamb-pin': 150           // Alternate ID
};

/**
 * Calculates the cost price for a service.
 * @param {string} serviceID - VTPass service identifier
 * @param {number} faceValue - The amount/price of the variation
 * @returns {number} The calculated cost for Zantara
 */
function calculateCost(serviceID, faceValue) {
    const rate = VTPASS_RATES[serviceID.toLowerCase()] || 0;
    
    // If rate is less than 1, treat as percentage
    if (rate > 0 && rate < 1) {
        return Number((faceValue * (1 - rate)).toFixed(2));
    }
    
    // If rate is 1 or more, treat as fixed commission (fixed earning)
    if (rate >= 1) {
        return Number((faceValue - rate).toFixed(2));
    }

    // Default: cost is equal to face value if no rate found
    return faceValue;
}

module.exports = {
    VTPASS_RATES,
    calculateCost
};
