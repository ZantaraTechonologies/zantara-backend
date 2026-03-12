const express = require('express');
const router = express.Router();
const { createTicket, getMyTickets, replyToTicket, getAllTickets, resolveTicket } = require('../controllers/supportController');
const { verifyJWT, checkRoles } = require('../middlewares/auth');

// User Routes
router.use(verifyJWT);
router.post('/create', createTicket);
router.get('/my-tickets', getMyTickets);
router.post('/reply/:id', replyToTicket);

// Admin Routes
router.get('/all', checkRoles('admin', 'superAdmin'), getAllTickets);
router.post('/resolve/:id', checkRoles('admin', 'superAdmin'), resolveTicket);

module.exports = router;
