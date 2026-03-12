const Ticket = require('../models/Ticket');
const notificationService = require('../services/notification.service');
const { sendResponse } = require('../utils/response');

const createTicket = async (req, res) => {
    try {
        const { subject, message, priority, transactionId } = req.body;
        const userId = req.user.id;

        if (!subject || !message) {
            return sendResponse(res, { status: 400, success: false, message: 'Subject and message are required' });
        }

        const ticket = await Ticket.create({
            userId, subject, message, priority, transactionId
        });

        return sendResponse(res, { message: 'Support ticket created successfully', data: ticket });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

const getMyTickets = async (req, res) => {
    try {
        const tickets = await Ticket.find({ userId: req.user.id }).sort({ createdAt: -1 });
        return sendResponse(res, { data: tickets });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

const replyToTicket = async (req, res) => {
    try {
        const { id } = req.params;
        const { message } = req.body;
        const userId = req.user.id;

        if (!message) {
            return sendResponse(res, { status: 400, success: false, message: 'Message is required' });
        }

        const ticket = await Ticket.findById(id);
        if (!ticket) return sendResponse(res, { status: 404, success: false, message: 'Ticket not found' });

        // Ensure user is the owner or an admin
        if (ticket.userId.toString() !== userId && !req.user.roles.includes('admin') && !req.user.roles.includes('superAdmin')) {
            return sendResponse(res, { status: 403, success: false, message: 'Unauthorized' });
        }

        ticket.responses.push({ sender: userId, message });
        let notificationTitle = 'New Support Reply';
        let notificationMessage = `You have a new reply to your ticket: ${ticket.subject}`;

        if (req.user.roles.includes('admin') || req.user.roles.includes('superAdmin')) {
            ticket.status = 'in-progress';
            // Notify the user of admin reply
            await notificationService.sendInApp(ticket.userId, {
                title: notificationTitle,
                message: notificationMessage,
                type: 'support',
                metadata: { ticketId: ticket._id }
            });
        }
        await ticket.save();

        return sendResponse(res, { message: 'Reply sent successfully', data: ticket });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

// Admin Endpoints
const getAllTickets = async (req, res) => {
    try {
        const tickets = await Ticket.find().populate('userId', 'name email').sort({ createdAt: -1 });
        return sendResponse(res, { data: tickets });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

const resolveTicket = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body; // e.g., 'resolved' or 'closed'

        const ticket = await Ticket.findByIdAndUpdate(id, { status }, { new: true });
        
        // Notify user of ticket resolution
        await notificationService.sendInApp(ticket.userId, {
            title: 'Support Ticket Update',
            message: `Your ticket "${ticket.subject}" has been marked as ${status}.`,
            type: 'support',
            metadata: { ticketId: ticket._id }
        });

        return sendResponse(res, { message: `Ticket ${status} successfully`, data: ticket });
    } catch (err) {
        return sendResponse(res, { status: 500, success: false, message: err.message });
    }
};

module.exports = { createTicket, getMyTickets, replyToTicket, getAllTickets, resolveTicket };
