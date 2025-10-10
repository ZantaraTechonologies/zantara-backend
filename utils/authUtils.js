// utils/authUtils.js
const jwt = require('jsonwebtoken');

const generateToken = (user, expiresIn = '7d') => {
    // roles: always an array (fallback to ['user'] if missing)
    const roles = Array.isArray(user.roles)
        ? user.roles
        : user.role
            ? [user.role]
            : ['user'];

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
    const roles = Array.isArray(user.roles) ? user.roles : (user.role ? [user.role] : ['user']);
    return res.status(status).json({ ok: true, user: { id: String(user._id), email: user.email, roles } });
};

const clearAuthCookie = (res) => res.clearCookie('token', cookieOpts());

module.exports = { generateToken, cookieOpts, sendToken, clearAuthCookie };