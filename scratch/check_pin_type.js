const mongoose = require('mongoose');
const path = require('path');
const dotenv = require('dotenv');

const backendPath = 'c:\\Users\\dahir\\Documents\\data_selling_app\\vtu-backend';
dotenv.config({ path: path.join(backendPath, '.env') });

async function checkPinType() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        const type = await mongoose.connection.db.collection('servicetypes').findOne({ slug: 'pin' });
        console.log('\n--- Service Type "pin" ---');
        console.log(JSON.stringify(type, null, 2));

        const allTypes = await mongoose.connection.db.collection('servicetypes').find().toArray();
        console.log('\n--- All Service Types ---');
        allTypes.forEach(t => console.log(`Slug: ${t.slug}, Name: ${t.name}, Status: ${t.status}`));

        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
    }
}

checkPinType();
