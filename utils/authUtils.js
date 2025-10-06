// auth.utils.js
const jwt = require('jsonwebtoken');

const generateToken = (user, expiresIn = '7d') =>
    jwt.sign({ id: user._id, role: user.role, email: user.email }, process.env.JWT_SECRET, { expiresIn });

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
    return res.status(status).json({ ok: true, user: { id: user._id, role: user.role, email: user.email } });
};

const clearAuthCookie = (res) => res.clearCookie('token', cookieOpts());

module.exports = { generateToken, cookieOpts, sendToken, clearAuthCookie };