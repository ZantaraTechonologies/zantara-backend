const mongoose = require('mongoose');
require('dotenv').config();

async function sync() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        const User = require('./models/User');
        
        // Sync all users who don't have lastLogin yet
        const result = await User.updateMany(
            { lastLogin: { $exists: false } },
            [ { $set: { lastLogin: '$updatedAt' } } ]
        );
        
        console.log(`Successfully synced ${result.modifiedCount} users with historical activity!`);
        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
}

sync();
