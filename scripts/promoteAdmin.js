require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('MONGO_URI is not defined in .env');
    process.exit(1);
}

const promoteUser = async (identifier, role = 'admin') => {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('Connected to Database');

        const user = await User.findOne({
            $or: [{ phone: identifier }, { email: identifier.toLowerCase() }]
        });

        if (!user) {
            console.error(`User with phone/email "${identifier}" not found`);
            process.exit(1);
        }

        user.role = role;
        user.roles = [role];
        await user.save();

        console.log(`User "${user.name}" (${user.phone}) has been promoted to "${role}" successfully.`);
        process.exit(0);
    } catch (error) {
        console.error('Error promoting user:', error);
        process.exit(1);
    }
};

const identifier = process.argv[2];
const targetRole = process.argv[3] || 'admin';

if (!identifier) {
    console.log('Usage: node scripts/promoteAdmin.js <phone_or_email> [role]');
    console.log('Available roles: user, agent, admin, superAdmin');
    process.exit(1);
}

promoteUser(identifier, targetRole);
