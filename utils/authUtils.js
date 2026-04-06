// utils/authUtils.js
const jwt = require('jsonwebtoken');

const generateToken = (user, expiresIn = '7d') => {
    // Collect roles from both legacy string and new array
    const userRoleString = user.role ? [user.role] : [];
    const userRolesArray = Array.isArray(user.roles) ? user.roles : [];
    let roles = [...new Set([...userRoleString, ...userRolesArray])]; // Combine & remove duplicates
    
    if (roles.length === 0) roles = ['user'];

    // OPTIONAL: pull perms from user if you add later
    const perms = user.perms ?? undefined;

    return jwt.sign(
        { id: String(user._id), email: user.email, roles, ...(perms ? { perms } : {}) },
        process.env.JWT_SECRET,
        { expiresIn }
    );
};

const cookieOpts = () => {
    const isProd = process.env.NODE_ENV === 'production';
    return {
        httpOnly: true,
        secure: isProd,                 // Render/HTTPS => true
        sameSite: isProd ? 'none' : 'lax',
        path: '/',                      // IMPORTANT
        // domain: '.yourdomain.com',   // only if you serve on a custom domain with subdomains
    };
};

const sendToken = (user, res, status = 200) => {
    const token = generateToken(user);
    res.cookie('token', token, cookieOpts());

    // return roles array to the client
    const userRoleString = user.role ? [user.role] : [];
    const userRolesArray = Array.isArray(user.roles) ? user.roles : [];
    let roles = [...new Set([...userRoleString, ...userRolesArray])];
    if (roles.length === 0) roles = ['user'];

    return res.status(status).json({ 
        ok: true, 
        token,
        user: { 
            id: String(user._id), 
            name: user.name,
            email: user.email, 
            phone: user.phone,
            roles,
            isPhoneVerified: user.isPhoneVerified,
            isPinSet: user.isPinSet
        } 
    });
};

const clearAuthCookie = (res) => res.clearCookie('token', cookieOpts());

module.exports = { generateToken, cookieOpts, sendToken, clearAuthCookie };