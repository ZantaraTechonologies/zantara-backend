const jwt = require('jsonwebtoken')

const verifyJWT = (req, res, next) => {
    const token =  req.cookies.token
    if (!token) return res.status(401).json({ message: 'Unauthorized' })
    
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET)
        req.user = decoded
        console.log(req.user)
        next()
    } catch (err) {
        return res.status(403).json({ message: 'Invalid or expired token' })
    }
}

const checkRole = role => (req, res, next) => {
    if (req.user.role !== role) return res.status(403).json({ message: 'Admin access required' })
    next()
}

module.exports = {
    verifyJWT,
    checkRole
}
