require('dotenv').config();

console.log('PORT:', process.env.PORT);
console.log('MONGO_URI Length:', process.env.MONGO_URI ? process.env.MONGO_URI.length : 'Not Set');
console.log('MONGO_URI Start:', process.env.MONGO_URI ? process.env.MONGO_URI.substring(0, 15) : 'N/A');
