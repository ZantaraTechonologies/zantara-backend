const Expense = require('../models/Expense');

exports.getExpenses = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        let filter = {};

        if (startDate || endDate) {
            filter.date = {};
            if (startDate) filter.date.$gte = new Date(startDate);
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                filter.date.$lte = end;
            }
        }

        const expenses = await Expense.find(filter).sort({ date: -1 });
        res.json({ success: true, data: expenses });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.createExpense = async (req, res) => {
    try {
        const expense = await Expense.create({
            ...req.body,
            createdBy: req.user.id
        });
        res.json({ success: true, data: expense });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
