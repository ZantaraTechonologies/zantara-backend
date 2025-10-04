// Import the Express framework to create the server
const express = require('express')

const mongoose = require('mongoose')

// Import Morgan middleware to log HTTP requests in the console
const morgan = require('morgan')

// Load environment variables from a .env file into process.env
require('dotenv').config()

// Create an instance of an Express application
const app = express()

app.set('trust proxy', 1); // you're on Render

const cookieParser = require('cookie-parser');
app.use(cookieParser());

// If you use the Vite proxy in dev, CORS is not needed for dev.
// Keep CORS for production if frontend is a different origin:
const cors = require('cors');
app.use(cors({
  origin: ['http://localhost:5173', 'https://your-frontend-domain.com'],
  credentials: true,
}));


// Body parser middleware
app.use(express.json()) // To parse JSON
app.use(express.urlencoded({ extended: true })) // To parse form data

// Use Morgan to log HTTP requests in 'dev' format (method, URL, status, response time)
app.use(morgan('dev'))

const index = require('./routes/index')
const analyticsRoutes = require('./routes/analytics')
const authRoutes = require('./routes/auth')
const walletRoutes = require('./routes/wallet')
const paystackRoutes = require('./routes/paystack')
const transactionRoutes = require('./routes/transaction')
const servicesRoutes = require('./routes/services')
const errorHandler = require('./middlewares/errorHandler')

// Mount the API routes under the '/api' path, loading route definitions from the routes/index.js file
app.use('/api', index)
app.use('/api/auth', authRoutes)
app.use('/api/wallet', walletRoutes)
app.use('/api/admin/stats', analyticsRoutes)
app.use('/api/paystack', paystackRoutes)
app.use('/api/transaction-logs', transactionRoutes)
app.use('/api/services', servicesRoutes)
app.use(errorHandler)

app.get('/', (req, res) => {
    res.send('API is live');
});

// Define the port number from the environment or default to 7000
const PORT = process.env.PORT || 7000
const MONGOURI = process.env.MONGO_URI


// Start the server and listen on the specified port
mongoose.connect(MONGOURI).then(() => {
    app.listen(PORT)
    console.log('API is Live')
}).catch(() => console.log('Error connecting to the Database'))