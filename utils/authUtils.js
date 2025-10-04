// auth.utils.js (your file)
const jwt = require('jsonwebtoken');

const generateToken = (user, expiresIn = '7d') =>
    jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn });

const cookieOpts = () => {
    const isProd = process.env.NODE_ENV === "production";
    return {
        httpOnly: true,
        secure: isProd,                 // Render/HTTPS => true
        sameSite: isProd ? "none" : "lax",  // dev works w/ proxy; prod supports cross-site
        path: "/",                      // IMPORTANT: match on clearCookie too
        // domain: ".yourdomain.com",   // only if you use a custom apex + subdomains
    };
};

const sendToken = (user, res, status = 200) => {
    const token = generateToken(user);
    res.cookie("token", token, cookieOpts());
    // No need to return token in body for cookie-auth:
    return res.status(status).json({ ok: true, user: { id: user._id, role: user.role, email: user.email } });
};

// For logout, reuse cookieOpts:
const clearAuthCookie = (res) => res.clearCookie("token", cookieOpts());

module.exports = { generateToken, sendToken, cookieOpts, clearAuthCookie };