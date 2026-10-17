const user = require("../controller/user");
const router =  require('express').Router();

// Signing up, in and out: /api/auth (routes/auth.js).
router.get('/profile', user.profile);
router.get('/rooms', user.rooms);
router.get('/current-game', user.current_game);

module.exports = router;
