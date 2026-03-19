const mongoose = require('mongoose');

const expenseSchema = new mongoose.Schema({
    category: { type: String, required: true }, // e.g., 'Server', 'Marketing', 'Salary'
    title: { type: String, required: true },
    amount: { type: Number, required: true },
    vendor: { type: String },
    date: { type: Date, default: Date.now },
    paymentSource: { type: String }, // e.g., 'Main Bank', 'Business Wallet'
    notes: { type: String },
    recurring: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

module.exports = mongoose.model('Expense', expenseSchema);
