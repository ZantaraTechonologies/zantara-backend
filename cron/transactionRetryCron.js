const cron = require('node-cron')
const TransactionStatus = require('../models/TransactionStatus')
const { retryTransaction, retryFunding } = require('../utils/transactionRetry')
const paymentGatewayService = require('../services/paymentGateway.service')

cron.schedule('*/5 * * * *', async () => {
    // 1. Existing retry logic for failed provider-side transactions
    const failed = await TransactionStatus.find({ status: 'failed', retries: { $lt: 5 } })
    for (const t of failed) {
        if (t.type === 'funding') await retryFunding(t.refId)
        else await retryTransaction(t.refId)
    }

    // 2. Crash-recovery sweep: finish transactions stranded in the settlement
    //    state machine ('settlement_pending' from an interrupted settle, or
    //    'processing' older than the crash-window threshold). Exactly-once and
    //    idempotent — see recoverStrandedSettlements.
    try {
        await paymentGatewayService.recoverStrandedSettlements()
    } catch (sweepErr) {
        console.error('[SETTLEMENT-RECOVERY] Sweep run failed', sweepErr.message)
    }

    console.log('Retry task completed')
})