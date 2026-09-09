const mongoose = require('mongoose');
const axios = require('axios');

/**
 * GET /api/admin/system/status
 * Comprehensive health check for all system dependencies
 */
exports.getSystemStatus = async (req, res) => {
    try {
        // 1. Database Check
        const dbStatus = mongoose.connection.readyState === 1 ? 'online' : 'offline';

        // 2. Vendor Gateway Check
        let vtpassStatus = 'offline';
        let vtpassMessage = 'Unreachable';
        try {
            const vtUrl = process.env.VTU_API_URI || 'https://sandbox.vtpass.com/api';
            const vtRes = await axios.get(vtUrl, { timeout: 5000, validateStatus: () => true });
            if (vtRes.status < 500) {
                vtpassStatus = 'online';
                vtpassMessage = 'Operational';
            } else {
                vtpassMessage = `HTTP ${vtRes.status}`;
            }
        } catch (err) {
            vtpassStatus = 'offline';
            vtpassMessage = err.message || 'Connection failed';
        }

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
                vtpassMessage: vtpassMessage || 'Operational'
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
