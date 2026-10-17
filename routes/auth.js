const {rateLimit} = require('express-rate-limit');
const {toNodeHandler} = require('better-auth/node');
const {auth} = require('../auth');
const router = require('express').Router();

// Better Auth's endpoints (auth.js), mounted at /api/auth. It reads the raw request body itself, so this router
// must come before express.json() in app.js.

// Per client IP, in memory. Behind a reverse proxy, set TRUST_PROXY so the real client IP is used. These come on top
// of Better Auth's own limits (on in production), with the error shape our frontend already knows.
function limit({limit, minutes, skipSuccessfulRequests = false}) {
    return rateLimit({
        windowMs: minutes * 60 * 1000,
        limit,
        skipSuccessfulRequests,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: {code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Wait a few minutes and try again.'},
    });
}

// Only failed sign-ins count, so guessing passwords is slow but normal use is never blocked.
router.post('/sign-in/username', limit({limit: 10, minutes: 15, skipSuccessfulRequests: true}));
router.post('/sign-up/email', limit({limit: 20, minutes: 60}));

router.all('*', toNodeHandler(auth));

module.exports = router;
