const mongoose = require('mongoose');
const path = require('path');
const dotenv = require('dotenv');

const backendPath = 'c:\\Users\\dahir\\Documents\\data_selling_app\\vtu-backend';
dotenv.config({ path: path.join(backendPath, '.env') });

const ServiceType = require(path.join(backendPath, 'models', 'ServiceType'));
const ServiceCategory = require(path.join(backendPath, 'models', 'ServiceCategory'));
const ServiceIdentity = require(path.join(backendPath, 'models', 'ServiceIdentity'));

async function checkTypesAndCategories() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        const types = await ServiceType.find();
        console.log('\n--- Service Types ---');
        types.forEach(t => console.log(`Slug: ${t.slug}, Name: ${t.name}, Status: ${t.status}`));

        const cats = await ServiceCategory.find();
        console.log('\n--- Service Categories ---');
        cats.forEach(c => console.log(`Slug: ${c.slug}, Name: ${c.name}, Status: ${c.status}`));

        const identities = await ServiceIdentity.find().populate('typeId');
        console.log('\n--- Service Identities (sample) ---');
        identities.forEach(i => {
            console.log(`Name: ${i.name}, Slug: ${i.slug}, Category (string): ${i.category}, TypeId Slug: ${i.typeId ? i.typeId.slug : 'None'}`);
        });

        await mongoose.disconnect();
    } catch (err) {
        console.error(err);
    }
}

checkTypesAndCategories();
