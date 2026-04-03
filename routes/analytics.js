const express = require('express')
const router = express.Router()
const {
    getDailyTransactions,
    revenuePerDay,
    topUsedServices,
    dailyUserRegistrations,
    getUserEarningsSummary,
    getUserEarningsHistory,
    getAdminEarningsAnalytics,
    getDashboardStats
} = require('../controllers/analyticsController')

const { verifyJWT, checkRoles } = require('../middlewares/auth')

// Protect with admin middleware if needed
router.get('/transactions/daily', getDailyTransactions)
router.get('/transactions/daily-revenue', revenuePerDay)
router.get('/services/top-used', topUsedServices)
router.get('/users/registrations/daily', dailyUserRegistrations)
router.get('/dashboard', verifyJWT, checkRoles('admin', 'superAdmin'), getDashboardStats)

// Admin Earnings (Step 11)
router.get('/admin/earnings', verifyJWT, checkRoles('admin', 'superAdmin'), getAdminEarningsAnalytics)

module.exports = router