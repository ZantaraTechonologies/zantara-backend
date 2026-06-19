const mongoose = require('mongoose');
require('dotenv').config();
const Broadcast = require('./models/Broadcast');

async function check() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB.');
        
        const allBroadcasts = await Broadcast.find().lean();
        console.log(`\nFound ${allBroadcasts.length} total broadcasts in database:`);
        
        allBroadcasts.forEach((b, index) => {
            console.log(`\n[Broadcast #${index + 1}]`);
            console.log(`ID: ${b._id}`);
            console.log(`Title: "${b.title}"`);
            console.log(`Active: ${b.active}`);
            console.log(`ExpiresAt: ${b.expiresAt}`);
            console.log(`Target: ${b.target}`);
            console.log(`CreatedAt: ${b.createdAt}`);
            
            // Check if it satisfies the getMyNotifications filters:
            const isActive = b.active === true;
            const isNotExpired = !b.expiresAt || new Date(b.expiresAt) > new Date();
            console.log(`Fits Filter -> Active: ${isActive}, Not Expired: ${isNotExpired}`);
        });
        
        await mongoose.disconnect();
        console.log('\nDisconnected.');
    } catch (err) {
        console.error('Error:', err);
    }
}

check();
