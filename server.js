// Import the Express framework to create the server
const express = require('express');
const mongoose = require('mongoose');
const morgan = require('morgan');
require('dotenv').config();

const app = express();

app.set('trust proxy', 1); // you're on Render

// Middlewares that don't touch the request body payload
const cookieParser = require('cookie-parser');
app.use(cookieParser());

const cors = require('cors');
app.use(cors({
    origin: ['http://localhost:5173', 'https://dahavtu.netlify.app'],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));

// ---- PAYSTACK WEBHOOK (RAW BODY) — MUST BE BEFORE express.json() ----
const { webhook } = require('./controllers/paystackController');
// Use express.raw so req.body is a Buffer for HMAC verification
app.post('/webhooks/paystack', express.raw({ type: 'application/json' }), webhook);

// ---- MONNIFY WEBHOOK ----
const { webhook: monnifyWebhook } = require('./controllers/monnifyController');
app.post('/webhooks/monnify', express.raw({ type: 'application/json' }), monnifyWebhook);
// --------------------------------------------------------------------
// --------------------------------------------------------------------

// Body parsers for the rest of your API
app.use(express.json());                         // Parse JSON
app.use(express.urlencoded({ extended: true })); // Parse form data

// ---- FLUTTERWAVE WEBHOOK (JSON BODY) ----
const { webhook: flutterwaveWebhook } = require('./controllers/flutterwaveController');
app.post('/webhooks/flutterwave', flutterwaveWebhook);
// --------------------------------------------------------------------

// Logging, caching headers, etc.
app.use(morgan('dev'));
app.set('etag', false); // avoid 304s based on ETag
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

// Routes
const index = require('./routes/index');
const analyticsRoutes = require('./routes/analytics');
const authRoutes = require('./routes/auth');
const adminAuthRoutes = require('./routes/adminAuth');
const adminRoutes = require('./routes/admin'); // Main admin Actions
const walletRoutes = require('./routes/wallet');
const paystackRoutes = require('./routes/paystack');
const monnifyRoutes = require('./routes/monnify');
const flutterwaveRoutes = require('./routes/flutterwave');
const transactionRoutes = require('./routes/transaction');
const servicesRoutes = require('./routes/services');
const errorHandler = require('./middlewares/errorHandler');

app.use('/api', index);
app.use('/api/auth', authRoutes);
app.get('/api/admin/auth/me', adminAuthRoutes); // maintain backward compat if needed, or point to new generic
app.use('/api/admin', adminRoutes);
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/admin/stats', analyticsRoutes);
app.use('/api/paystack', paystackRoutes);
app.use('/api/monnify', monnifyRoutes);
app.use('/api/flutterwave', flutterwaveRoutes);
app.use('/api/transaction-logs', transactionRoutes);
app.use('/api/services', servicesRoutes);

// Global error handler (keep last)
app.use(errorHandler);

// Health
app.get('/', (req, res) => {
    res.send('API is live');
});

// Boot
const PORT = process.env.PORT || 7000;
const MONGOURI = process.env.MONGO_URI;

mongoose.connect(MONGOURI).then(() => {
    app.listen(PORT, () => console.log(`API is Live on port ${PORT}`));
}).catch(() => console.log('Error connecting to the Database'));