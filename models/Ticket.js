const mongoose = require('mongoose');

const ticketSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    subject: { type: String, required: true },
    message: { type: String, required: true },
    priority: { type: String, enum: ['low', 'medium', 'high'], default: 'low' },
    status: { type: String, enum: ['open', 'in-progress', 'resolved', 'closed'], default: 'open' },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
    responses: [{
        sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        message: { type: String, required: true },
        createdAt: { type: Date, default: Date.now }
    }]
}, { timestamps: true });

const Ticket = mongoose.model('Ticket', ticketSchema);

module.exports = Ticket;
