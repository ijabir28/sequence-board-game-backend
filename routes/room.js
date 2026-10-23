const room_router =  require('express').Router();
const {create, join, leave, room, shuffle, update_settings} = require('../controller/room');
const room_game = require('../controller/room_game');
const friends = require('../controller/friends');

room_router.post('/create', create);
room_router.get('/:id', room);
room_router.post('/:id/join', join);
room_router.post('/:id/leave', leave);
room_router.post('/:id/invite', friends.invite);
room_router.post('/:id/shuffle', shuffle);
room_router.patch('/:id/settings', update_settings);
room_router.post('/:id/start', room_game.start);
room_router.get('/:id/game', room_game.get);
room_router.get('/:id/turns', room_game.turns);
room_router.post('/:id/game/play', room_game.play);
room_router.post('/:id/game/exchange', room_game.exchange);
room_router.post('/:id/game/pass', room_game.pass);
room_router.post('/:id/game/forfeit', room_game.forfeit);
room_router.post('/:id/rounds/next', room_game.next_round);
room_router.post('/:id/rounds/end', room_game.end_rounds);
room_router.get('/:id/rounds/:round', room_game.round_detail);

module.exports = {room_router};
