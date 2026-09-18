const User = require('../models/User')
const { verifyAccessToken } = require('../utils/authTokens')

const tokenVersion = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

const requestToken = req => {
    if (req.cookies?.token) return req.cookies.token;
    const authorization = req.headers?.authorization;
    if (!authorization) return null;
    return authorization.startsWith('Bearer ') ? authorization.slice(7) : authorization;
};

const loadAccessIdentity = async decoded => {
    const user = await User.findById(decoded.id).select('status role roles name phone perms authVersion');
    if (!user) return { reason: 'missing' };
    if (!user.status) return { reason: 'inactive' };
    if (tokenVersion(decoded.authVersion) !== tokenVersion(user.authVersion)) {
        return { reason: 'revoked' };
    }

    const roles = Array.isArray(user.roles)
        ? user.roles
        : (Array.isArray(user.role) ? user.role : []);
    const perms = Array.isArray(user.perms) && user.perms.length > 0 ? user.perms : [];
    return {
        identity: {
            ...decoded,
            role: user.role || null,
            roles,
            perms,
            status: user.status,
            ...(user.name ? { name: user.name } : {}),
            ...(user.phone ? { phone: user.phone } : {})
        }
    };
};

const verifyJWT = async (req, res, next) => {
    const token = requestToken(req)

    if (!token) return res.status(401).json({ message: 'Not authenticated' })

    try {
        const decoded = verifyAccessToken(token)
        const resolved = await loadAccessIdentity(decoded);
        if (resolved.reason === 'missing') {
            return res.status(401).json({ message: 'Account no longer exists' });
        }
        if (resolved.reason === 'inactive') {
            return res.status(403).json({ message: 'Account is disabled' });
        }
        if (resolved.reason === 'revoked') {
            return res.status(401).json({ message: 'Session has been revoked' });
        }
        req.user = resolved.identity;
        next()
    } catch (err) {
        if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError' || err.code === 'TOKEN_PURPOSE_MISMATCH') {
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
const verifyJWTOptional = async (req, res, next) => {
    const token = requestToken(req);

    if (!token) return next();

    try {
        const decoded = verifyAccessToken(token);
        const resolved = await loadAccessIdentity(decoded);
        if (resolved.identity) req.user = resolved.identity;
    } catch (_) {
        // Invalid, revoked, inactive, and deleted identities are anonymous here.
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
