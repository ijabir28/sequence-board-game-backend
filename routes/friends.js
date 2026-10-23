const router = require('express').Router();
const friends = require('../controller/friends');

// Friends and table invitations (controller/friends.js). Inviting a friend to a table is POST /room/:id/invite.
// Nothing answers bare /friends: that is the frontend's page, served by app.js's catch-all.
router.get('/list', friends.overview);
router.get('/search', friends.search);
router.post('/requests', friends.send_request);
router.post('/requests/:handle/accept', friends.accept_request);
router.delete('/requests/:handle', friends.delete_request);
router.get('/invitations', friends.invitations);
router.delete('/invitations/:room_id', friends.dismiss_invitation);
router.delete('/:handle', friends.unfriend);

module.exports = router;
