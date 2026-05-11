const mongoose = require('mongoose');
require('dotenv').config();

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('MONGO_URI not found in environment variables');
  process.exit(1);
}

mongoose.connect(uri)
  .then(async () => {
    const User = require('./models/User');
    const totalUsers = await User.countDocuments();
    console.log('--- DB STATS ---');
    console.log('Total Users:', totalUsers);
    
    const admins = await User.find({ 
      $or: [ { role: 'admin' }, { roles: 'admin' }, { role: 'superadmin' } ] 
    }).select('firstName lastName email role roles kycLevel phone');
    console.log('\n--- ADMIN USERS ---');
    console.log(admins);
    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
