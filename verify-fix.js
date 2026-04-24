const mongoose = require('mongoose');
const PricingRule = require('./models/PricingRule');
require('dotenv').config();

async function verify() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("Connected to DB");

        // Try to create a global rule with empty string targetId (should fail if my fix didn't work)
        // Actually I should test the controller logic.
        
        const controller = require('./controllers/adminHierarchyController');
        
        const req = {
            body: {
                targetType: 'global',
                targetId: '',
                markupType: 'percent',
                markupValue: 10
            },
            user: { id: '65f123456789012345678901', name: 'Test Admin' },
            ip: '127.0.0.1',
            headers: {}
        };
        
        const res = {
            status: function(s) { this.statusCode = s; return this; },
            json: function(j) { this.data = j; return this; }
        };

        await controller.createPricingRule(req, res);
        
        console.log("Response Status:", res.statusCode || 200);
        console.log("Response Data:", JSON.stringify(res.data, null, 2));

        if (res.data.success) {
            console.log("SUCCESS: Global rule created with null targetId");
        } else {
            console.log("FAILED: " + res.data.message);
        }

        await mongoose.disconnect();
    } catch (err) {
        console.error("Test Error:", err);
        process.exit(1);
    }
}

verify();
