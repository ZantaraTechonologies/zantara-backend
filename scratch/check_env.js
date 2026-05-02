require('dotenv').config();
console.log('JWT_SECRET present:', !!process.env.JWT_SECRET);
console.log('JWT_SECRET length:', process.env.JWT_SECRET?.length);
console.log('MONGO_URI present:', !!process.env.MONGO_URI);
