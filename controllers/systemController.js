const mongoose = require('mongoose');
const axios = require('axios');
const vtpassAdapter = require('../adapters/vtpass.adapter');

/**
 * GET /api/admin/system/status
 * Comprehensive health check for all system dependencies
 */
exports.getSystemStatus = async (req, res) => {
    try {
        // 1. Database Check
        const dbStatus = mongoose.connection.readyState === 1 ? 'online' : 'offline';

        // 2. VTPass Check
        const vtpassCheck = await vtpassAdapter.ping();
        const vtpassStatus = vtpassCheck.success ? 'online' : 'offline';

        // 3. Paystack Check
        let paystackStatus = 'offline';
        try {
            // Paystack doesn't have a specific health endpoint, so we ping their public API base
            const psUrl = process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co';
            await axios.get(psUrl, { timeout: 5000 });
            paystackStatus = 'online';
        } catch (err) {
            // Note: Even if Paystack returns 401/404, if they responded, they are "online"
            if (err.response) {
                paystackStatus = 'online';
            } else {
                paystackStatus = 'offline';
            }
        }

        res.json({
            success: true,
            status: {
                database: dbStatus,
                vtpass: vtpassStatus,
                paystack: paystackStatus,
                server: 'online',
                timestamp: new Date()
            },
            details: {
                vtpassMessage: vtpassCheck.message || 'Operational'
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
