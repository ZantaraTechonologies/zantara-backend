const router = require('express').Router()

router.get('/', (req, res) => {
    res.json({ message: 'VTU API Ready' })
});

module.exports = router
