'use strict';

const virtualAccountService = require('../services/virtualAccount.service');
const { serializeVirtualAccounts } = require('../utils/virtualAccountSerializer');

const provisionVirtualAccount = async (req, res) => {
    try {
        const result = await virtualAccountService.provision({
            userId: req.user.id,
            providerCode: req.params.provider,
            preferredBank: req.body?.preferredBank,
            consent: req.body?.consent === true
        });
        return res.status(result.status === 'pending' ? 202 : 200).json({
            success: true,
            status: result.status,
            existing: result.existing,
            accounts: serializeVirtualAccounts(result.accounts)
        });
    } catch (error) {
        const status = error.httpStatus || (error.response ? 502 : 500);
        return res.status(status).json({
            success: false,
            code: error.code || 'VIRTUAL_ACCOUNT_PROVISIONING_FAILED',
            message: error.message
        });
    }
};

module.exports = { provisionVirtualAccount };
