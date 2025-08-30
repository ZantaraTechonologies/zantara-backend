const cron = require('node-cron');
const { retryTransaction } = require('../utils/transactionRetry')

cron.schedule('*/5 * * * *', async () => {
    const failedTransactions = await TransactionStatus.find({ status: 'failed', retries: { $lt: 5 } })

    for (const transaction of failedTransactions) {
        await retryTransaction(transaction.refId);
    }

    console.log('Retry task completed')
})