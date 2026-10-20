const router = require('express').Router();
const matchmaking = require('../controller/matchmaking');
const user = require('../controller/user');

// Quick Match: the queue (controller/matchmaking.js) and its own leaderboard.
router.post('/queue', matchmaking.join);
router.get('/queue', matchmaking.status);
router.delete('/queue', matchmaking.leave);
router.get('/leaderboard', user.matchmaking_leaderboard);

module.exports = router;
