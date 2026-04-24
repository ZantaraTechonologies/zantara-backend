const express = require('express');
const router = express.Router();
const catalogController = require('../../controllers/v2/catalogController');
const { verifyJWT } = require('../../middlewares/auth');

/**
 * Normalized Catalog Routes (v2)
 */

// Full catalog hierarchy
router.get('/', catalogController.getCatalog);

// Specific lists
router.get('/categories', catalogController.getCategories);
router.get('/types/:categoryId', catalogController.getTypesByCategory);

module.exports = router;
