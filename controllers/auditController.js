const AuditLog = require('../models/AuditLog');

exports.getAuditLogs = async (req, res) => {
    try {
        const { search, page = 1, limit = 50 } = req.query;
        let filter = {};

        if (search) {
            filter.$or = [
                { operatorName: { $regex: search, $options: 'i' } },
                { action: { $regex: search, $options: 'i' } }
            ];
        }

        const logs = await AuditLog.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(Number(limit));

        const total = await AuditLog.countDocuments(filter);

        res.json({ 
            success: true, 
            data: logs,
            pagination: {
                total,
                page: Number(page),
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.logAction = async (adminId, operatorName, action, target, details, result = 'success', req = null) => {
    try {
        const logData = {
            adminId,
            operatorName,
            action,
            target,
            details,
            result
        };

        if (req) {
            logData.ipAddress = req.ip || req.headers['x-forwarded-for'];
            logData.userAgent = req.headers['user-agent'];
        }

        await AuditLog.create(logData);
    } catch (error) {
        console.error('Audit logging failed:', error);
    }
};
