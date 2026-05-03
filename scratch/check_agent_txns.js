/**
 * Show all service types so we know what targetId to use
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
    await mongoose.connect(process.env.MONGO_URI);
    const ServiceType = mongoose.model('ServiceType', new mongoose.Schema({}, { strict: false }), 'servicetypes');
    const types = await ServiceType.find({});
    console.log('=== All Service Types ===');
    types.forEach(t => console.log(`  ${t._id} | name=${t.name} | slug=${t.slug}`));
    await mongoose.disconnect();
}
main().catch(console.error);
