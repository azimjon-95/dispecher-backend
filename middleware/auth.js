const jwt = require('jsonwebtoken')

module.exports = function auth(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token yo\'q' })
  }
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET || 'secret')
    req.user = payload
    next()
  } catch {
    res.status(401).json({ error: 'Token noto\'g\'ri yoki muddati o\'tgan' })
  }
}
