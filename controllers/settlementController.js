const Settlement = require('../models/Settlement');

exports.getSettlements = async (req, res) => {
    try {
        const settlements = await Settlement.find().sort({ date: -1 });
        res.json({ success: true, data: settlements });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.createSettlement = async (req, res) => {
    try {
        const settlement = await Settlement.create({
            ...req.body,
            initiatedBy: req.user.id
        });
        res.json({ success: true, data: settlement });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
