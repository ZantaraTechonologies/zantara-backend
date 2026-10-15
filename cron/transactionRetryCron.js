const cron = require('node-cron')
const paymentGatewayService = require('../services/paymentGateway.service')
const notificationService = require('../services/notification.service')
const virtualAccountService = require('../services/virtualAccount.service')

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

    try {
        await notificationService.recoverStaleCredentialSmsDeliveries()
    } catch (sweepErr) {
        console.error('[SMS-RECOVERY] Sweep run failed', sweepErr.message)
    }

    try {
        const result = await virtualAccountService.recoverProvisioning()
        if (!result.skipped && (result.scanned > 0 || result.eligibilityScanned > 0)) {
            console.info('[VirtualAccount] Recovery sweep completed', {
                scanned: result.scanned,
                claimed: result.claimed,
                eligibilityScanned: result.eligibilityScanned,
                eligibilityEligible: result.eligibilityEligible,
                active: result.active,
                pending: result.pending,
                failed: result.failed
            })
        }
    } catch (sweepErr) {
        console.error('[VirtualAccount] Recovery sweep failed', {
            code: sweepErr.code || 'VIRTUAL_ACCOUNT_RECOVERY_FAILED'
        })
    }

    console.log('Retry task completed')
}, { noOverlap: true })
