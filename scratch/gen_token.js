require('dotenv').config();
const jwt = require('jsonwebtoken');

const token = jwt.sign(
    { id: '65e123456789012345678901', roles: ['admin'] },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
);
console.log(token);
