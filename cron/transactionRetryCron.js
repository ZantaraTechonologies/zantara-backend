const cron = require('node-cron')
const paymentGatewayService = require('../services/paymentGateway.service')

cron.schedule('*/5 * * * *', async () => {
    // VTU purchases are never resubmitted automatically. Ambiguous fulfillment
    // remains pending until an idempotent provider requery resolves it.

    // Crash-recovery sweep: finish transactions stranded in the settlement
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
