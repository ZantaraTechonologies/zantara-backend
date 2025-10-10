const jwt = require('jsonwebtoken')

const verifyJWT = (req, res, next) => {
    const token = req.cookies?.token
    if (!token) return res.status(401).json({ message: 'Not authenticated' })

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET)
        req.user = decoded
        console.log(req.user)
        next()
    } catch (err) {
        return res.status(403).json({ message: 'Invalid or expired token' })
    }
}

const checkRoles = (...allowed) => (req, res, next) => {
    const roles = req.user?.roles ?? [];
    const ok = Array.isArray(roles) && roles.some(r => allowed.includes(r));
    if (!ok) return res.status(403).json({ message: 'Forbidden: Insufficient role', requiredRoles: allowed });
    next();
};

const requirePermsAll = (...need) => (req, res, next) => {
    const perms = req.user?.perms ?? [];
    const ok = need.every(p => perms.includes(p));
    if (!ok) return res.status(403).json({ message: "Forbidden: missing permissions", requiredPerms: need });
    next();
};

module.exports = {
    verifyJWT,
    checkRoles,
    requirePermsAll
}