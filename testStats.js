const mongoose = require('mongoose');
require('dotenv').config({ path: './.env' });

async function testStats() {
    try {
        console.log("Connecting to Database...");
        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected.");

        const User = require('./models/User');
        const Transaction = require('./models/Transaction');
        const Kyc = require('./models/Kyc');
        const WithdrawalRequest = require('./models/WithdrawalRequest');
        const Ticket = require('./models/Ticket');

        console.log("Fetching Statistics...");

        const [
            totalUsers,
            activeUsersSet,
            pendingKyc,
            pendingWithdrawals,
            withdrawalVolumeStats,
            failedTxsToday,
            openTickets
        ] = await Promise.all([
            User.countDocuments(),
            Transaction.distinct('userId', { status: 'success' }),
            Kyc.countDocuments({ status: 'pending' }),
            WithdrawalRequest.countDocuments({ status: 'pending' }),
            WithdrawalRequest.aggregate([
                { $match: { status: 'pending' } },
                { $group: { _id: null, total: { $sum: "$amount" } } }
            ]),
            Transaction.countDocuments({ status: 'failed', createdAt: { $gte: new Date(new Date().setHours(0,0,0,0)) } }),
            Ticket.countDocuments({ status: { $in: ['open', 'in-progress'] } })
        ]);

        console.log("\n--- DASHBOARD STATS TEST ---");
        console.log("Total Users:", totalUsers);
        console.log("Active Users:", activeUsersSet.length);
        console.log("Pending KYC:", pendingKyc);
        // Withdrawals
        console.log("Pending Withdrawals:", pendingWithdrawals);
        console.log("Withdrawal Volume (Pending):", withdrawalVolumeStats[0]?.total || 0);
        // Transactions
        console.log("Failed Txs Today:", failedTxsToday);
        // Tickets
        console.log("Open Tickets:", openTickets);
        console.log("----------------------------\n");

        await mongoose.disconnect();
        console.log("Disconnected.");
    } catch (err) {
        console.error("Test failed:", err);
        process.exit(1);
    }
}

testStats();
