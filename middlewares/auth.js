const jwt = require('jsonwebtoken')

const verifyJWT = (req, res, next) => {
    let token = req.cookies?.token
    
    // Support Authorization header (Bearer <token>)
    if (!token && req.headers.authorization) {
        if (req.headers.authorization.startsWith('Bearer ')) {
            token = req.headers.authorization.split(' ')[1];
        } else {
            token = req.headers.authorization;
        }
    }

    if (!token) return res.status(401).json({ message: 'Not authenticated' })

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET)
        req.user = decoded
        next()
    } catch (err) {
        return res.status(403).json({ message: 'Invalid or expired token' })
    }
}

const checkRoles = (...allowed) => (req, res, next) => {
    // Suppport both legacy 'role' string and new 'roles' array
    const rolesArray = Array.isArray(req.user?.roles) 
        ? req.user.roles 
        : (req.user?.role ? [req.user.role] : []);

    const ok = rolesArray.some(r => allowed.includes(r));
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