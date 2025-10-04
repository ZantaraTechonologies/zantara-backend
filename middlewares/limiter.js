const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: 'Too many login attempts. Try again in a minute.',
    standardHeaders: true,
    legacyHeaders: false
})

module.exports = {
    loginLimiter
}
// const rateLimit = require("express-rate-limit");

// const limiter = rateLimit({
//     windowMs: 15 * 60 * 1000,
//     max: 100,
//     standardHeaders: true,
//     legacyHeaders: false,
//     // Ensure we key by Express' computed client IP (honors trust proxy):
//     keyGenerator: (req) => req.ip,

//     // If you absolutely cannot set trust proxy (not your case), you could disable this validation:
//     // validate: { xForwardedForHeader: false }, // <-- not recommended; prefer trust proxy
// });

// app.use(limiter);
