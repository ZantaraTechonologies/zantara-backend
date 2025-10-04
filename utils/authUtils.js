const jwt = require('jsonwebtoken')

const generateToken = (user, expiresIn = '7d') => {
    return jwt.sign(
        { id: user._id, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn }
    )
}

const sendToken = (user, res) => {
    const token = generateToken(user)

    res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Strict',
        maxAge: 7 * 24 * 60 * 60 * 1000
    })

    res.json({ success: true, token, user })
}

const cookieOpts = () => {
    const isProd = process.env.NODE_ENV === "production";
    return {
        httpOnly: true,
        secure: isProd,              // Render/HTTPS => true
        sameSite: isProd ? "none" : "lax",
        path: "/",                   // must match your login cookie path
        // If you set a domain when logging in, include it here too:
        // domain: ".yourdomain.com",
    };
}

module.exports = {
    generateToken,
    sendToken,
    cookieOpts
}