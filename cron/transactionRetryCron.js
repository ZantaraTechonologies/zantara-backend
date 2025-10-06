const cron = require('node-cron')
const TransactionStatus = require('../models/TransactionStatus')
const { retryTransaction } = require('../utils/transactionRetry')

cron.schedule('*/5 * * * *', async () => {
    const failed = await TransactionStatus.find({ status: 'failed', retries: { $lt: 5 } })
    for (const t of failed) {
        if (t.type === 'funding') await retryFunding(t.refId)
        else await retryTransaction(t.refId)
    }
    console.log('Retry task completed')
})
