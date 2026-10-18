const express = require('express');
// Express 4.16 predates express.raw; this is the parser it wraps.
const body_parser = require('body-parser');
const user = require("../controller/user");
const {AVATAR_MAX_BYTES, ACCEPTED_TYPES} = require('../entity/avatar');
const router = express.Router();

// Signing up, in and out, and changing the name, email or password: /api/auth (routes/auth.js).
router.get('/profile', user.profile);
router.get('/rooms', user.rooms);
router.get('/current-game', user.current_game);

// A little over the limit, so an oversized picture gets entity/avatar.js's message rather than the parser's.
router.put('/avatar', body_parser.raw({type: ACCEPTED_TYPES, limit: AVATAR_MAX_BYTES + 1024}), user.upload_avatar);
router.delete('/avatar', user.remove_avatar);
router.get('/avatar/:id', user.avatar);
router.put('/card-deck', user.set_card_deck);
router.put('/board-style', user.set_board_style);

module.exports = router;
