// utils/authUtils.js
const { generateAccessToken } = require('./authTokens');

const generateToken = (user, expiresIn = '7d') => {
    return generateAccessToken(user, expiresIn);
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

const sendToken = (user, res, status = 200, expiresIn = '7d', extra = {}) => {
    const token = generateToken(user, expiresIn);
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
            isPhoneVerified: user.isPhoneVerified === true,
            isEmailVerified: user.isEmailVerified === true,
            isPinSet: user.isPinSet === true,
            kycLevel: Number(user.kycLevel || 1),
            myReferralCode: user.myReferralCode || null
        },
        ...(extra.onboarding ? { onboarding: extra.onboarding } : {})
    });
};

const clearAuthCookie = (res) => res.clearCookie('token', cookieOpts());

module.exports = { generateToken, cookieOpts, sendToken, clearAuthCookie };
