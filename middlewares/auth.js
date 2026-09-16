const jwt = require('jsonwebtoken')
const User = require('../models/User')

const verifyJWT = async (req, res, next) => {
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

        // Enforce account status (CRIT 2): a disabled or deleted user must not
        // be able to use any previously-issued token.
        const user = await User.findById(decoded.id).select('status role roles name phone perms');
        if (!user) {
            return res.status(401).json({ message: 'Account no longer exists' });
        }
        if (!user.status) {
            return res.status(403).json({ message: 'Account is disabled' });
        }

        // SECURITY INVARIANT: once the current User document is loaded,
        // authorization fields come EXCLUSIVELY from the live DB state.
        // JWT establishes identity; DB establishes current authorization.
        // Never restore role/roles/perms from a stale JWT after DB lookup.
        const hydratedRoles = Array.isArray(user.roles)
            ? user.roles
            : (Array.isArray(user.role) ? user.role : []);
        const hydratedPerms = Array.isArray(user.perms) && user.perms.length > 0
            ? user.perms
            : [];

        req.user = {
            ...decoded,
            role: user.role || null,
            roles: hydratedRoles,
            perms: hydratedPerms,
            status: user.status,
            ...(user.name ? { name: user.name } : {}),
            ...(user.phone ? { phone: user.phone } : {})
        }
        next()
    } catch (err) {
        if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
            return res.status(403).json({ message: 'Invalid or expired token' })
        }
        return res.status(500).json({ message: 'Internal server error' })
    }
}

const checkRoles = (...allowed) => (req, res, next) => {
    const userRoleString = req.user?.role ? [req.user.role] : [];
    const userRolesArray = Array.isArray(req.user?.roles) ? req.user.roles : [];
    const rolesArray = [...userRoleString, ...userRolesArray];

    const ok = rolesArray.some(r => allowed.includes(r));
    if (!ok) return res.status(403).json({ message: 'Forbidden: Insufficient role', requiredRoles: allowed });
    next();
};

// Optional auth for read-only routes that must NEVER block (e.g. legal
// requirements). Populates req.user when a valid token is present; anonymous
// and expired/invalid-token callers fall through as anonymous. It never
// rejects and never returns 401/403.
const verifyJWTOptional = (req, res, next) => {
    let token = req.cookies?.token;

    if (!token && req.headers.authorization) {
        if (req.headers.authorization.startsWith('Bearer ')) {
            token = req.headers.authorization.split(' ')[1];
        } else {
            token = req.headers.authorization;
        }
    }

    if (!token) return next();

    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch (_) {
        // Invalid/expired token -> treat as anonymous (legal reads never blocked).
    }
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
    verifyJWTOptional,
    requirePermsAll
}