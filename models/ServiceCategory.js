const mongoose = require('mongoose');

const serviceCategorySchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    slug: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    description: {
        type: String
    },
    status: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });


module.exports = mongoose.model('ServiceCategory', serviceCategorySchema);
