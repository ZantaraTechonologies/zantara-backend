const mongoose = require('mongoose');
const path = require('path');
const dotenv = require('dotenv');

const backendPath = 'c:\\Users\\dahir\\Documents\\data_selling_app\\vtu-backend';
dotenv.config({ path: path.join(backendPath, '.env') });

async function listCollections() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        const collections = await mongoose.connection.db.listCollections().toArray();
        console.log('\n--- Collections ---');
        collections.forEach(c => console.log(c.name));

        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
    }
}

listCollections();
