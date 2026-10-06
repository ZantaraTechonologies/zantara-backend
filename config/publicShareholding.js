'use strict';

// Temporary compliance hold while the Monnify KYC review is in progress.
// Fail closed unless operations explicitly set the flag to "false".
const PUBLIC_SHAREHOLDING_KYC_HOLD = process.env.PUBLIC_SHAREHOLDING_KYC_HOLD !== 'false';
const PUBLIC_SHAREHOLDING_HOLD_CODE = 'PUBLIC_SHAREHOLDING_HOLD';
const PUBLIC_SHAREHOLDING_HOLD_MESSAGE = 'Public shareholding services are temporarily unavailable.';

const isPublicShareholdingAvailable = () => !PUBLIC_SHAREHOLDING_KYC_HOLD;

const createPublicShareholdingHoldError = () => Object.assign(
    new Error(PUBLIC_SHAREHOLDING_HOLD_MESSAGE),
    {
        code: PUBLIC_SHAREHOLDING_HOLD_CODE,
        status: 503,
        statusCode: 503
    }
);

const assertPublicShareholdingAvailable = () => {
    if (!isPublicShareholdingAvailable()) throw createPublicShareholdingHoldError();
};

module.exports = {
    PUBLIC_SHAREHOLDING_KYC_HOLD,
    PUBLIC_SHAREHOLDING_HOLD_CODE,
    PUBLIC_SHAREHOLDING_HOLD_MESSAGE,
    isPublicShareholdingAvailable,
    createPublicShareholdingHoldError,
    assertPublicShareholdingAvailable
};
