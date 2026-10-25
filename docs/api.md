# API contract

Base URL `http://localhost:3000`. Request bodies are JSON (`Content-Type: application/json`); urlencoded also
works. Auth means "uses the session cookie set by `/api/auth/sign-in/username`". There is no global error handler, so thrown
errors come back as Express's default **HTML** 500 page, not JSON. Behaviour below was confirmed against a
running server.

## Health

### `GET /health`
`200 {status: 'ok', database: 'up'}` when PostgreSQL answers, `503 {status: 'error', database: 'down'}` when it
doesn't. Used by the backend's Docker healthcheck.

## Accounts (Better Auth)

Signing up, in and out is [Better Auth](https://better-auth.com) 1.7, mounted at `/api/auth` (`auth.js`). Its
errors are JSON `{code, message}`; its messages are terse, so the frontend words them itself. Handles are
case-insensitive: Better Auth's `username` is the handle, trimmed and lower-cased before use. Every `POST` must come
from a trusted origin (`BETTER_AUTH_URL`, plus `http://localhost:3000` in development) or it is `403 INVALID_ORIGIN`;
browsers send `Origin` themselves. The session cookie is `sequence.session_token` (HttpOnly, `SameSite=Lax`,
`Secure` over HTTPS). Only the endpoints the frontend uses are listed; the rest are Better Auth's defaults.

### `POST /api/auth/sign-up/email`
Body `{username, name, email, password}`. Creates the account and emails a link to confirm the address; it does not
sign in. A sign-up with an email that already has an account answers the same and creates nothing (the address's
owner is emailed instead), so nobody can find out which emails are registered.
- Success: `200 {token: null, user}`.
- `400 USERNAME_TOO_SHORT`, `USERNAME_TOO_LONG`, `INVALID_USERNAME` (3–20 of `a-z 0-9 _`), `400 USERNAME_IS_ALREADY_TAKEN`.
- `400 INVALID_NAME` (1–10 characters after trimming; accounts made before this limit keep longer names).
- `400 VALIDATION_ERROR` for a malformed email.
- `400 PASSWORD_TOO_SHORT` / `PASSWORD_TOO_LONG` (8–200 characters).
- `429 TOO_MANY_ATTEMPTS` after 20 sign-ups from one IP within an hour.

### `POST /api/auth/sign-in/username`
Body `{username, password}`. Development accounts (created by `npm run db:seed`): `jabir` / `1`, `sakib` / `123`.
- Success: `200 {token, user}`, sets the session cookie (a new session on every sign-in). An account is signed in on
  one device at a time: every other session of the account is deleted, so other devices get `401` on their next
  request, and `signed_in_elsewhere {handle}` is broadcast (see [Socket.IO](#socketio)). Confirming an email signs in
  too, with the same effect.
- `401 INVALID_USERNAME_OR_PASSWORD` for a wrong password or an unknown handle (the two are indistinguishable).
- `403 EMAIL_NOT_VERIFIED` for a right password on an account whose email isn't confirmed yet. A new confirmation link
  is emailed (at most once a minute) and `message` names the masked address. Accounts made before emails were asked
  for have none to confirm and sign in as before.
- `429 TOO_MANY_ATTEMPTS` after 10 failed sign-ins from one IP within 15 minutes. Successful sign-ins don't count.

### `POST /api/auth/sign-out`
Deletes the session row and clears the cookie. `200 {success: true}`.

### Email confirmation
The emailed link is `GET /api/auth/verify-email?token=…&callbackURL=%2Femail-verified` (valid 24 hours). It confirms
the address, signs in and redirects to the frontend's `/email-verified`, or to `/email-verified?error=INVALID_TOKEN`
(or `TOKEN_EXPIRED`). `POST /api/auth/send-verification-email {email}` emails a new link; `200` whether or not the
address has an account. `429 TOO_MANY_ATTEMPTS` after 5 from one IP within 15 minutes.

### Password reset
- `POST /api/auth/request-password-reset {email, redirectTo: "/reset-password"}`: emails a link if an account uses
  the address; `200` either way. `429 TOO_MANY_ATTEMPTS` after 5 from one IP within 15 minutes.
- The link, `GET /api/auth/reset-password/:token?callbackURL=%2Freset-password` (valid once, for an hour), redirects
  to the frontend's `/reset-password?token=…`, or `/reset-password?error=INVALID_TOKEN`.
- `POST /api/auth/reset-password {token, newPassword}`: `200`, then every session of the account is deleted, the email
  counts as confirmed (the link went there) and a "password changed" email goes out. `400 INVALID_TOKEN` for an
  expired or used token, `400 PASSWORD_TOO_SHORT` / `PASSWORD_TOO_LONG`.

## User

Errors are JSON `{error: CODE, message}`; `message` is readable by players. Auth means "uses the session cookie".

### `GET /user/profile` (auth)
`200 {handle, name, email, email_verified, image, card_deck, board_style, friends_can_watch, created_at, stats: {played, won, playing}}`,
or `401 NOT_SIGNED_IN`. Clients can use it to ask "am I signed in?". `email` is `null` for accounts made before
emails were asked for; `image` is the avatar's URL or `null`; `card_deck` is the hand card deck the player chose (see
`PUT /user/card-deck`) and `board_style` how their board's cells look (`PUT /user/board-style`), each `null` until
chosen. `stats` counts the table games the player has a seat in: finished (`played`), won by their team (`won`) and
in progress (`playing`).

### `PUT /user/avatar` (auth)
The picture as the raw body, `Content-Type` `image/png`, `image/jpeg` or `image/webp`, at most 256 KB (the frontend
crops and shrinks it to 256×256 first). The type is read from the bytes. `200 {image}`, the URL that now serves it,
also in `users.image`. `415 UNSUPPORTED_MEDIA_TYPE` for another content type (SVG included), `400 INVALID_IMAGE` when
the bytes aren't one of those formats, `413 IMAGE_TOO_LARGE`.

### `DELETE /user/avatar` (auth)
`204`; `image` goes back to `null`.

### `GET /user/avatar/:id`
Anyone's avatar, as its image, or `404 NOT_FOUND`. The URL carries a version (`?v=…`) that changes with every upload,
so the response is cached for a year. It is served with `nosniff` and a sandboxing Content-Security-Policy.

### `PUT /user/card-deck {card_deck}` (auth)
The design the player's hand is shown in, kept on the account so it follows them to every device. The frontend owns
the list of decks (its `src/decks/decks.ts`), so the server only checks the id's shape: 1 to 32 lowercase letters,
digits or dashes. `200 {card_deck}`, or `400 INVALID_CARD_DECK`.

### `PUT /user/board-style {board_style}` (auth)
How the player's board cells look (the frontend's board styles, `dark` or `cards` today), kept on the account like the
card deck and checked the same way. `200 {board_style}`, or `400 INVALID_BOARD_STYLE`.

### Profile changes (Better Auth)
All need the session cookie and a trusted `Origin`.
- `POST /api/auth/update-user {name}`: the display name, with the rule above (`400 INVALID_NAME`). The handle can't
  change (`400 USERNAME_IS_IMMUTABLE`: games and socket tokens refer to players by it), and `image` can't be set here
  (`400 IMAGE_READ_ONLY`).
- `POST /api/auth/change-email {newEmail, callbackURL: "/profile"}`: `200` and nothing changes yet. If the current
  address is confirmed, it is emailed a link to approve the move; then (or straight away for an account without an
  email, or an unconfirmed one) the new address gets a link that confirms it and makes the change. Both links redirect
  to `callbackURL`. An address that already has an account answers the same and changes nothing.
- `POST /api/auth/change-password {currentPassword, newPassword, revokeOtherSessions: true}`: `200`, every other
  session is deleted and a "password changed" email goes out. `400 INVALID_PASSWORD` for a wrong current password.
- `GET /api/auth/list-sessions`: the account's sessions (`createdAt`, `updatedAt`, `userAgent`, `token`, …). With one
  device at a time that is just this one. `POST /api/auth/revoke-other-sessions {}` still deletes all but this one.

### `GET /user/rooms` (auth)
One page of the tables you created or sat at, newest first. Query `page` (from 1, default 1) and `per_page`
(default 10, at most 50); missing or invalid values use the defaults. A page past the end has no rooms.
`401 NOT_SIGNED_IN` without a session.

```jsonc
{
 "page": 1, "per_page": 10, "total": 23, "pages": 3,
 "rooms": [{
  "id": "friday-night-k3m9", "name": "Friday Night", "created_at": "…", "administrator": "jabir",
  "administrator_name": "Jabir ibne kamal",
  "team_count": 2, "players_per_team": 1, "seats_taken": 2,
  "settings": {"history": false, "highlights": false, "auto_draw_dead": false, "turn_seconds": 90, "dead_cards": "manual", "exchanges_per_turn": null},
  "your_team": 0,                      // null when you only created the table
  "status": "playing",                 // open (no game yet) | playing | finished, of the current round
  "started_at": "…", "last_move_at": "…", "finished_at": null, "winner_team": null,
  "move_count": 12,                    // the game columns are the current (latest) round's
  "round": 2,                          // null before the first round starts
  "rounds_over": false                 // the host has ended the rounds
 }, …]
}
```

### `GET /user/current-game` (auth)
`200 {room}`: the game in progress where you have a seat that moved most recently (the room as in
`GET /user/rooms`), or `{room: null}`. For a dashboard's "resume your game". `401 NOT_SIGNED_IN` without a session.

### `PUT /user/friends-can-watch` (auth)
Body `{friends_can_watch: true|false}`: whether friends get a link to watch the player's table games from their friends
list (`watch` in `GET /friends/list`). Off for every account until turned on. `200 {friends_can_watch}`, `400
INVALID_SETTING` for anything but a boolean. The player's friends hear `friends_updated`.

### `GET /user/leaderboard?scope=friends&period=all&page=1&per_page=20` (auth)
One page of the leaderboard, best first. `scope` is `friends` (default: the signed-in player and their friends only,
ranked among themselves) or `global` (every rated player), which is refused with `403 GLOBAL_LEADERBOARD_DISABLED`
unless the server's `GLOBAL_LEADERBOARD` setting is `on`; `scopes` in the answer lists the ones offered.
`period` is `all` (default: everyone on the board with a won round, by Elo rating),
`week` or `day` (players who finished a round in the last 7 days / 24 hours, by the rating they gained there).
`per_page` defaults to 20, at most 50. Each player is
`{rank, position, handle, name, image, score, rating, rating_change, played, won, lost, win_rate}`: `rank` is shared by
ties, `position` is 1, 2, 3… down the board; `score` is what the board ranks by (`rating` all time, `rating_change`
otherwise); `rating_change` is the change since 1200 all time; `win_rate` is `won / played` from 0 to 1.
`200 {scope, scopes, period, players, you, page, per_page, total, pages}`, where `you` is the signed-in player's own
entry with the `page` it is on, or `null` when they aren't on this board. `400 INVALID_PERIOD`, `400 INVALID_SCOPE`,
`401 NOT_SIGNED_IN`. Ratings change
when a round is won; see [architecture](architecture.md#rooms-games-and-history). This board only counts private
tables; Quick Match has its own, [`GET /matchmaking/leaderboard`](#get-matchmakingleaderboardperiodallpage1per_page20-auth).

## Quick Match

Players queue for a table shape and the server seats them with others who asked for the same. See
[architecture](architecture.md#quick-match-and-bots).

### `POST /matchmaking/queue {teams, timer}` (auth)
Joins the queue. `teams` is `2` or `3` (always one player per team); `timer` is `blitz` (15 s turns), `medium` (45 s)
or `slow` (90 s). Every other setting is the default of a new table. Asking again with another shape moves the player
to that queue (keeping their place only for the same shape). Answers `200` with the status (below): `matched` at once
when enough players were waiting, else `queued`; `playing` (and not queued) when the player already has a quick match in
progress, which they should go back to. `400 INVALID_MATCH_SETTINGS`, `401 NOT_SIGNED_IN`.

### `GET /matchmaking/queue` (auth)
The status. A waiting page must call it every few seconds: a player not heard from for 30 seconds has left the queue.

```jsonc
{"status": "queued", "teams": 2, "timer": "blitz", "turn_seconds": 15,
 "joined_at": "…",                  // nothing says when bots would be brought in, or who else waits
 "server_time": "…"}
{"status": "matching"}               // the table is being made: ask again
{"status": "matched", "room_id": "quick-match-k3m9"}   // seated (kept for 5 minutes): open /room/:id/game
{"status": "playing", "room_id": "quick-match-k3m9"}   // a quick match of theirs is in progress
{"status": "idle"}
```

### `DELETE /matchmaking/queue` (auth)
Leaves the queue. `200` with the status (`idle`, or `playing`).

### `GET /matchmaking/leaderboard?period=all&page=1&per_page=20` (auth)
The Quick Match leaderboard, exactly like [`GET /user/leaderboard`](#get-userleaderboardscopefriendsperiodallpage1per_page20-auth)
but over quick matches only, with ratings of its own (from 1200), and the same `scope`. Bots are rated, so beating one counts, but are never
listed.

## Friends

Errors are JSON `{error: CODE, message}`, `message` readable by players; every endpoint needs a session (`401
NOT_SIGNED_IN`). A player is named by their handle (case-insensitive, a leading `@` is ignored); bots are nobody's
friends (`404 PLAYER_NOT_FOUND`), and naming yourself is `400 CANNOT_FRIEND_SELF`. Every change is announced to both
players' own sockets as `friends_updated` (see [Socket.IO](#socketio)). Nothing answers bare `GET /friends`: that path
is the frontend's page.

### `GET /friends/list` (auth)
`200 {friends, incoming, outgoing, invitations}`. `friends`: `[{handle, name, image, since, online, playing, watch}]` by
name, where `online` says the friend has the app open, `playing` whether they have a seat at a table game in progress,
and `watch` that table's code, only when the friend lets friends watch ([`PUT /user/friends-can-watch`](#put-userfriends-can-watch-auth)),
else `null`. `incoming` / `outgoing`: requests waiting, `[{handle, name, image, sent_at}]`, newest first.
`invitations`: tables friends asked the player to whose game hasn't started and where they have no seat,
`[{room_id, room_name, from: {handle, name, image}, sent_at, seats_taken, seats}]`, newest first.

### `GET /friends/search?q=…` (auth)
Up to 10 players whose handle starts with `q` or whose name contains it (case-insensitive; at least 2 letters, else
`400 INVALID_SEARCH`), never the player or a bot: `200 {players: [{handle, name, image, relationship}]}`, where
`relationship` is `none`, `friends`, `incoming` or `outgoing`.

### `POST /friends/requests {handle}` (auth)
Asks to be friends: `200 {handle, relationship: 'outgoing'}`; when they had already asked, it accepts theirs instead
(`relationship: 'friends'`). `409 ALREADY_FRIENDS`, `409 ALREADY_REQUESTED`, `409 TOO_MANY_PENDING` (50 unanswered).

### `POST /friends/requests/:handle/accept` (auth)
Accepts their request: `200 {handle, relationship: 'friends'}`, or `404 REQUEST_NOT_FOUND`.

### `DELETE /friends/requests/:handle` (auth)
Declines their request or takes back yours: `204`, or `404 REQUEST_NOT_FOUND`.

### `DELETE /friends/:handle` (auth)
Ends the friendship (and drops invitations between the two): `204`, or `403 NOT_FRIENDS`.

### `GET /friends/invitations` (auth) · `DELETE /friends/invitations/:room_id` (auth)
The `invitations` of `GET /friends/list`; dismissing one is `204`, or `404 INVITATION_NOT_FOUND`. Taking a seat at
the table removes it too. Each dismissal makes the next invitation to that table wait longer: 5, 15, 30, 60 and then
120 minutes after the 1st to 5th dismissal. After a 6th (the first invitation plus five re-invites), nobody can invite
that player to that table again.

### `POST /room/:id/invite {handle}` (auth)
Asks a friend to the table: `200 {handle}`. Only someone seated there or its host, before the game starts, while a seat
is free. Inviting again renews the invitation. The friend hears `table_invitation`. `403 NOT_AT_TABLE`, `403
NOT_FRIENDS`, `404 ROOM_NOT_FOUND`, `409 GAME_ALREADY_STARTED` (quick match tables included), `409 ALREADY_SEATED`,
`409 TABLE_FULL`, `403 REMOVED_BY_HOST` (the host sent that friend away; only the host can invite them back, which
lets them sit down again), `429 INVITE_COOLDOWN` (they dismissed an invitation to this table recently; the message says
how long to wait), `409 INVITE_LIMIT` (they dismissed too many).

### `GET /room/:id/invite-status` (auth)
For someone who may invite to the table (seated there, or its host): `200 {dismissed: [{handle, dismissals, retry_at,
limit_reached}], removed: [handle]}`. `retry_at` (ISO time) is when that player can be invited again, `null` when they
can be now or never again (`limit_reached`). `removed` lists players the host sent away, which only the host can invite
back; it is empty for everyone else. `403 NOT_AT_TABLE`, `404 ROOM_NOT_FOUND`.

## Room

Rooms, seats, games and every move are stored in PostgreSQL, so tables and games in progress survive restarts.

### `POST /room/create` (auth)
Body `{number_of_team, number_of_player_in_each_team, name?, history?, highlights?, auto_draw_dead?,
turn_seconds?, dead_cards?, exchanges_per_turn?}`. Counts are numbers or numeric strings; `turn_seconds` is a whole number from 15 to 600; `dead_cards` is `"manual"` or `"indicator"`;
`exchanges_per_turn` is `null` or `"unlimited"`, or a whole number from 1 to 10; the other settings are booleans (or
`"true"` / `"false"`).
`200 {id}`. `id` is the table's code: a slug of its name plus a 4-character suffix, such as `"friday-night-k3m9"`.
Without a name the table gets a generated one ("Lucky Otter"). The signed-in user becomes `administrator` (the host).
Errors are JSON `{error, message}`: `401 NOT_SIGNED_IN`, `400 UNSUPPORTED_TABLE` for a table size the rules
can't deal for (2 or 3 teams; 2, 3, 4, 6, 8, 9, 10 or 12 players in total), `400 INVALID_NAME` (over 40
characters), `400 INVALID_SETTINGS`.

Settings and their defaults:

| Setting | Default | Effect |
|---|---|---|
| `history` | `false` | Off: `GET /room/:id/turns` is `403 HISTORY_DISABLED` and the GameView's `log` keeps only the latest move |
| `highlights` | `false` | Off: clients don't light up legal cells (the server only reports the setting) |
| `turn_seconds` | `90` | Seconds each player has for a turn. Clients offer 30, 60, 90, 120 and 180, or any whole number from 15 to 600 |
| `dead_cards` | `"manual"` | `"manual"`: nothing marks dead cards; players spot them and ask to exchange them, and the server refuses a card that isn't dead (`NOT_DEAD`). The GameView's `can_exchange` is then true whenever the current player has exchanges left, so it never gives a dead card away. `"indicator"`: clients mark dead cards in the hand, and `can_exchange` is true only when one is there |
| `exchanges_per_turn` | `null` (unlimited) | How many dead cards a player may exchange in one turn: `null` for unlimited, or 1 to 10. Rooms created before this setting allow 1 |
| `auto_draw_dead` | `false` | With `dead_cards: "indicator"` only. On: dead cards are exchanged automatically when their owner's turn starts (as many as `exchanges_per_turn` allows, counted as theirs), logged as `{kind: "exchange", auto: true, …}` |

Room codes created before slugs are numeric strings (`"731791746123232"`) and still work.

A table whose game never started is deleted once nothing has happened there for a day (`OPEN_TABLE_IDLE_HOURS`,
default 24): opened earlier, with nobody sitting down or being invited since. The server sweeps hourly and at start-up;
`room_updated {id, deleted: true}` is broadcast for each, and invited players hear `friends_updated`.

### `PATCH /room/:id/settings` (auth, host)
Body `{name?, mode?, history?, highlights?, auto_draw_dead?, turn_seconds?, dead_cards?, exchanges_per_turn?}`; missing keys keep their value. The code never changes.
`200` with the Room, and `room_updated` is broadcast. `401 NOT_SIGNED_IN`, `403 NOT_HOST`, `404 ROOM_NOT_FOUND`,
`409 GAME_ALREADY_STARTED` (settings are fixed once the game starts), `400 INVALID_NAME | INVALID_SETTINGS`.

### `GET /room/:id`
`200` with a Room, or `200` with an **empty body** when the id doesn't exist.

```jsonc
// Room
{
  "administrator": "jabir",                  // the host's handle
  "administrator_name": "Jabir ibne kamal",  // the host's display name, for messages
  "id": "friday-night-k3m9",
  "name": "Friday Night",
  "settings": {"history": false, "highlights": false, "auto_draw_dead": false, "turn_seconds": 90, "dead_cards": "manual", "exchanges_per_turn": null},
  "created_at": "2026-10-15T05:48:22.696Z",
  "teams": [
    { "handle": "TEAM_1", "players": [ {"handle": "jabir", "name": "Jabir ibne kamal"}, null ] },
    { "handle": "TEAM_2", "players": [ null, null ] }
  ],
  "standing": [ {"handle": "sakib", "name": "Sakib"} ],          // at the table without a seat (stood up)
  "invited": [ {"handle": "nadia", "name": "Nadia", "invited_by": "jabir"} ],  // invited, not yet sat down
  "game_started": false,
  "round": null,                             // the current round, from 1; null before the game starts
  "rounds_over": false                       // the host has ended the rounds
}
```
Team handles are `TEAM_1 … TEAM_n`. Empty seats are `null`. Player objects are `{handle, name}`.

### `POST /room/:id/join` (auth)
Body `{team_handle}`. Takes the first empty seat in that team. Always HTTP `200`; check `message`:
- `{"message": "success"}`, then the server broadcasts `room_updated`.
- `{"message": "SEAT_TAKEN"}` when the team is full.
- `{"message": "ALREADY_SEATED"}` when you already have a seat at this table.
- `{"message": "NOT_SIGNED_IN"}` without a session.
- `{"message": "GAME_ALREADY_STARTED"}` once the table's game has started.
- `{"message": "REMOVED_BY_HOST"}` when the host sent you away from this table (until they invite you back).
- `{"message": "ROOM_NOT_FOUND"}` or `{"message": "TEAM_NOT_FOUND"}`.

Joins to the same room are serialised, so a contested last seat goes to exactly one player.

### `POST /room/:id/leave` (auth)
Stand up from your seat before the game starts, to take another seat or let the host reshuffle the teams.
`200` with the Room, and `room_updated` is broadcast. JSON errors: `401 NOT_SIGNED_IN`, `404 ROOM_NOT_FOUND`,
`409 NOT_SEATED` (you have no seat here), `409 GAME_ALREADY_STARTED` (seats are fixed once the game starts).

### `POST /room/:id/shuffle` (auth, host)
Deals the seated players out to the seats at random before the game starts, keeping teams as even as possible
(seat 1 of every team first, then seat 2, …). `200` with the Room, and `room_updated` is broadcast. `401`, `403
NOT_HOST`, `404 ROOM_NOT_FOUND`, `409 GAME_ALREADY_STARTED`.

### Host controls (auth, host)
Before the game starts, the host runs the seating. Each answers `200` with the Room and broadcasts `room_updated`.
Shared errors: `401 NOT_SIGNED_IN`, `403 NOT_HOST` (quick match tables have no host), `404 ROOM_NOT_FOUND`,
`404 PLAYER_NOT_FOUND`, `409 GAME_ALREADY_STARTED`.

- `POST /room/:id/seat {handle, team_handle, seat}`: puts a player at the table (seated, standing, invited, or the
  host) in that seat, `seat` counting from 0 within the team. Whoever sat there trades places with them, or stands up
  if they had no seat. Seating an invited player answers their invitation. `400 SEAT_NOT_FOUND`, `409 NOT_AT_TABLE`.
- `POST /room/:id/unseat {handle}`: stands a player up. They stay in `standing`. `409 NOT_SEATED`.
- `POST /room/:id/kick {handle}`: sends a player away: their seat, place at the table and invitation go, and joining
  answers `REMOVED_BY_HOST` until the host invites them back. They hear `removed_from_table`. `400 CANNOT_KICK_SELF`.
- `DELETE /room/:id/invitations/:handle`: takes back a player's invitation. They hear `friends_updated`.
  `409 NOT_INVITED`.

To list your rooms, see [`GET /user/rooms`](#get-userrooms-auth).

## Table game

A full game for a room, run by the server (`entity/sequence_game.js`). Errors are JSON `{error, message}`, where
`message` is readable by players: `401 NOT_SIGNED_IN`, `403 NOT_A_PLAYER | NOT_HOST`, `404 ROOM_NOT_FOUND | GAME_NOT_FOUND`,
`409 GAME_ALREADY_STARTED | TABLE_NOT_FULL | NOT_YOUR_TURN | GAME_OVER | ROUND_IN_PROGRESS | ROUNDS_OVER`, and `400` for rule errors (`CELL_MISMATCH`,
`CELL_OCCUPIED`, `CORNER`, `OWN_CHIP`, `LOCKED_CHIP`, `NOT_DEAD`, `HAS_MOVES`, …).

### `POST /room/:id/start` (auth)
Deals a game once every seat is taken. Only the table's creator (the host, `administrator`) may start it; anyone
else gets `403 NOT_HOST`. Seats alternate
teams (T1, T2, [T3,] T1, …), and a seat drawn at random moves first in round 1. Each later round starts with the seat
after the one that started the round before, so the first turn passes to the next team every round, and within each team to
its next player (2 teams of 2 whose round 1 T1's first player opened: T2's first player opens round 2, T1's second round 3, T2's
second round 4, then round again). The state keeps the opening seat as `first`. Returns a GameView and broadcasts `room_updated` and
`game_updated`.

The game is played in **rounds**. `start` deals round 1; once a round is won, the host either deals another round
with the same teams ([`POST /room/:id/rounds/next`](#post-roomidroundsnext-auth-host)) or ends the rounds there
([`POST /room/:id/rounds/end`](#post-roomidroundsend-auth-host)), which gives the table its final result. The GameView
is always the current (latest) round's, with every won round's statistics in `rounds`.

Moves on one table are applied one at a time: of two simultaneous moves by the current player, the second
gets `409 NOT_YOUR_TURN`. Every accepted move is recorded (see [`GET /room/:id/turns`](#get-roomidturns)).

### `GET /room/:id/game`
The GameView for the session's user. Anyone with the table's code may watch, signed in or not: a spectator gets the
same view with `viewer: null`, an empty `hand`, no `presence_token` and nothing they may do (`can_exchange`, `can_pass`
false). Every move, forfeit and round decision refuses them (`401 NOT_SIGNED_IN`, `403 NOT_A_PLAYER` or `NOT_HOST`).

```jsonc
// GameView
{
  "team_count": 2, "sequences_to_win": 2,
  "players": [{"handle": "jabir", "name": "Jabir ibne kamal", "team": 0, "hand_count": 7}, …],   // a bot's seat looks like anyone's
  "current_player": "jabir",          // null once the game is won
  "turn": 1,
  "board": [[{"name": "Blank", "team": null}, {"name": "6-Diamond", "team": 0}, …], …],   // 10×10, team is 0|1|2|null
  "viewer": "jabir",                  // null for a spectator
  "hand": ["4-Spade", "J-Club", …],
  "can_exchange": false, "can_pass": false,
  "exchanges_left": null,             // current player only: dead card exchanges left this turn (null: unlimited)
  "deck_count": 90,
  "sequences": [{"team": 0, "cells": [{"row": 0, "column": 1}, …]}],
  "winner": null,
  "name": "Friday Night",            // the room's name
  "host": "jabir",                   // the host's handle: they deal each round and decide whether another follows
  "matchmaking": false,              // a Quick Match table: one round, which ends the rounds when won
  "forfeited": false,                // the viewer forfeited this quick match: they see it as a spectator
  "rounds": {…},                     // the table's rounds, see below
  "turn_started_at": "2026-10-15T06:55:15.349Z",   // when the current turn began (null for games stored before)
  "turn_deadline": "2026-10-15T06:56:45.349Z",     // when the turn's timer runs out (null once the game is over or while paused)
  "turn_paused": false,              // the current player is away from the table, so their turn waits for them
  "turn_time_left_ms": null,         // while paused: the time the current player will have left; else null
  "away": ["sakib"],                 // seated players whose game page isn't open
  "presence_token": "q9…",           // seated players only: send it with the socket's join_game (null for spectators)
  "spectators": 2,                    // sockets watching without a seat (watch_game)
  "server_time": "2026-10-15T06:55:21.002Z",       // the server's clock now, to run a turn timer despite clock skew
  "settings": {"history": false, "highlights": false, "auto_draw_dead": false, "turn_seconds": 90, "dead_cards": "manual", "exchanges_per_turn": null},
  "log": [{"kind": "place", "turn": 1, "player": "Jabir ibne kamal", "team": 0, "card": "4-Spade", "pos": {"row": 1, "column": 5}, "wild": false}, …]
}
```

`rounds` says where the table is in its rounds. `results` lists the won rounds in order (the current one too once it
is won), and `summary` is the final result once the host has ended the rounds (null until then):

```jsonc
{
  "round": 2,                        // the current round, from 1
  "over": false,                     // the host ended the rounds: no further round can be dealt
  "results": [{
    "round": 1, "winner": 0, "started_at": "…", "finished_at": "…",
    "stats": {                       // null only for a round won before statistics were kept
      "winner": 0, "turns": 38, "first_player": "jabir",
      // chips: on the board at the end; placed: chips put down (wild jacks too); removed: opponents' chips taken off
      "teams": [{"team": 0, "sequences": 2, "chips": 21, "placed": 23, "removed": 3}, …],
      // plays: cards played; wilds: two-eyed jacks; removals: one-eyed jacks; timed_out: moves made for them
      "players": [{"handle": "jabir", "name": "Jabir ibne kamal", "team": 0, "plays": 19, "wilds": 2, "removals": 2,
                   "exchanges": 1, "passes": 0, "timed_out": 0}, …]
    }
  }],
  "summary": {                       // once over: every round added up
    "rounds_played": 3, "turns": 104,
    "teams": [{"team": 0, "rounds_won": 2, "sequences": 5, "placed": 61, "removed": 7}, …],
    "players": [{"handle": "jabir", …totals as in a round…}, …],
    "verdict": {"winner": 0, "leaders": [0]}   // most rounds won; with several leaders it's a draw and winner is null
  }
}
```

When `turn_deadline` passes, the server plays for the current player: a random card from their hand that can be
played, on a random legal cell (after exchanging a dead card if nothing else can be played; a pass if nothing can be
done). It is recorded like any move, with `timed_out: true` on the turn and on the log entries it made, and
`game_updated` is broadcast.

Nobody plays for a player who isn't at the table. A seated player is at the table while their game page has a socket
that sent `join_game` (see [Socket.IO](#socketio)); a dropped socket counts as gone after a 4 second grace period.
When the current player is away, their turn is **paused**: `turn_deadline` is null, `turn_paused` is true and
`turn_time_left_ms` says how long they'll have. The game waits on their turn until they're back, then the timer runs
on from exactly where it stopped (the time spent away doesn't count, and there is no minimum). A turn that starts while its player is away (the first turn,
before anyone has opened the game, for example) starts paused. Presence is kept in memory, so after a restart everyone
is away until their page reconnects, which it does by itself. Every arrival and departure broadcasts `game_updated`.

Quick Match tables are the exception: their players are strangers, so a turn never pauses (an absent player's turns
are played for them when the timer runs out), and the first turn gets 10 extra seconds for everyone to open the game.
Bots are never away; the server plays a bot's turn 1.5 to 7 seconds after it starts (it varies, as a person's would).
A quick match player whose timer plays for them 10 turns in a row forfeits (below); a move of their own resets the
count, kept in the state as `missed`.

### `POST /room/:id/game/forfeit` (auth) — quick matches only
The signed-in player gives up. With two teams the other team wins at once (the log gets a `forfeit` entry, then the
`win`) and the round is rated as usual, the forfeiter's loss marked `forfeit` in `matchmaking_results`. With three
teams the forfeiter loses rating at once (a loss to each other team, each counting half) and a bot plays the rest of
the game from their seat, under their name, with nothing in any view to say so; if that seat wins, nobody is rated,
and if a person wins, the round is rated as usual without the forfeiter. Either way the forfeiter's GameView has
`forfeited: true` and no hand, and they may queue again. `200` with that view; `409 FORFEITED` (already),
`409 NOT_A_QUICK_MATCH`, `409 GAME_OVER`, `403 NOT_A_PLAYER`.

### `POST /room/:id/game/play` (auth) — body `{hand_index, row, column}`
### `POST /room/:id/game/exchange` (auth) — body `{hand_index}` (a dead card, up to `exchanges_per_turn` per turn, before playing)
### `POST /room/:id/game/pass` (auth) — only when no card can be played or exchanged

Each applies the move for the current player, draws a replacement card, and returns the new GameView. Every change
broadcasts `game_updated`.

### `POST /room/:id/rounds/next` (auth, host)
Once the current round is won, deals the next one: the same teams and seats, an empty board, a fresh deck, and the
first turn to the seat after the one that started the round before (another team's player). Returns
the new round's GameView and broadcasts `game_updated` and `room_updated`. `403 NOT_HOST`, `404 GAME_NOT_FOUND`
(nothing dealt yet), `409 ROUND_IN_PROGRESS` (the round isn't won yet), `409 ROUNDS_OVER`.

### `POST /room/:id/rounds/end` (auth, host)
Once the current round is won, ends the rounds: the GameView's `rounds.summary` then holds the final result, and no
further round can be dealt. Returns the GameView and broadcasts `game_updated` and `room_updated`. Same errors as
`rounds/next`.

### `GET /room/:id/rounds/:round`
How a won round went, to look back on it (the final results link to every round). Public, like the GameView. The
log is the round's whole move log, whatever the room's history setting, since the round is over; hands and the deck
are never included. `404 ROUND_NOT_FOUND`, `409 ROUND_IN_PROGRESS` while that round is played.

```jsonc
{
  "round": 1, "winner": 0, "started_at": "…", "finished_at": "…",
  "stats": {…},                       // as in rounds.results
  "team_count": 2,
  "players": [{"handle": "jabir", "name": "Jabir ibne kamal", "team": 0}, …],
  "board": [[{"name": "Blank", "team": null}, …], …],   // the board as the round ended
  "sequences": [{"team": 0, "cells": […]}, …],
  "log": [{"kind": "place", …}, …]   // every move, oldest first
}
```

### `GET /room/:id/turns`
The current round's moves so far, oldest first. Public, like the game view, and never includes hands or the deck.
`404 ROOM_NOT_FOUND | GAME_NOT_FOUND`, `403 HISTORY_DISABLED` when the room plays without history; `[]` when the
game has started but nobody has moved.

```jsonc
[{
  "move_number": 1,                    // 1, 2, 3… across the round
  "turn": 1,                           // the game's turn counter; an exchange shares it with the next play
  "player": {"handle": "jabir", "name": "Jabir ibne kamal"},
  "team": 0,
  "kind": "play",                      // play | exchange | pass
  "card": "4-Spade",                   // null for a pass
  "cell": {"row": 1, "column": 5},     // only for a play
  "events": [{"kind": "place", …}],    // the log entries the move produced (also sequence and win)
  "timed_out": false,                  // true when the server played it because the turn timer ran out
  "created_at": "2026-10-15T05:48:22.705Z"
}, …]
```

## Board

### `GET /board/deck`
`200 {deck: Cell[10][10]}`, where `Cell = {name: string, occupied_by?: string}`. This is the legacy game's
live board: `occupied_by` would be set to a team handle (`team1` / `team2`) after a successful move. See
[game-domain.md](game-domain.md) for the layout.

## Game (legacy global game)

### `GET /game/hand_cards?player_handler=<handle>`
`200 {cards_in_hand: [{name}]}` (5 cards). Valid handles: `jabir`, `sakib`, `habiba`, `humaira`; any other
handle gives a `500`. The session is not used; anyone can read any hand.

### `GET /game/play` (a GET that changes state)
Query string:
- `player_handler`: handle as above
- `hand_card_index`: index into that player's hand
- `board_card_index`: URL-encoded JSON `{"row": r, "column": c}`

Responses:
- Invalid move: `404`, plain text `Invalid Move`.
- Valid move: `200 {verdict: "Valid", team}`. The chip is placed (or removed by a one-eyed jack) and the played card
  is replaced from the deck. There is still no turn order; use the table game for real play.
- (Before the fix, every valid move was a `500` because
  `current_team` is undefined. The board is not changed and no card is drawn.

## Socket.IO

Same origin and port as HTTP, default path `/socket.io`. The server also serves the matching client script at
`/socket.io/socket.io.js`. Use a `socket.io-client` with the **same major version** as the installed server.

| Event (server → client) | Payload | When |
|---|---|---|
| `room_updated` | Room (see above), or `{id, deleted: true}` | After every successful join or game start, or when an idle table is deleted, sent to **every** connected socket |
| `teams_shuffled` | `{room_id, by: {handle, name}, room}` | After the host shuffles the teams (`room` is the new seating), so clients can tell players their new team |
| `game_updated` | `{room_id}` | After a table game starts or changes. Re-fetch `GET /room/:id/game`; the payload has no hands |
| `spectators_updated` | `{room_id, count}` | A spectator started or stopped watching that table's game |
| `match_found` | `{room_id, players: [handle]}` | The Quick Match queue seated these players at a new table (every seat, bots' too, alike). A waiting page whose player is listed can open the game (polling `GET /matchmaking/queue` says the same) |
| `removed_from_table` | `{room_id}` | Only to the sockets of a player the host sent away from that table |
| `friends_updated` | `{}` | Only to the sockets of a player whose friends, requests or invitations changed: re-fetch `GET /friends/list` |
| `table_invitation` | `{room_id, room_name, from: {handle, name, image}}` | Only to the invited friend's sockets |
| `table_chat_history` | `{room_id, messages: [Message]}` | Only to the socket that sent `open_table_chat`: the table's last 50 messages, oldest first |
| `table_chat` | `{room_id, message: Message}` | Someone said something at the table. Sent to **every** socket with that table's chat open, the sender's too |
| `table_reaction` | `{room_id, reaction: {id, author: {handle, name}, reaction, at}}` | Someone reacted at the table, sent like `table_chat`. Reactions are not kept |
| `signed_in_elsewhere` | `{handle}` | That account signed in on a device and its other sessions were deleted. A page signed in as `handle` should re-check its session (`GET /user/profile`): the event is public, so it proves nothing by itself |

Who a socket is (for the two events sent to one player) is read from the session cookie of its handshake when it
connects; a page whose player signs in or out should reconnect.

| Event (client → server) | Payload | Meaning |
|---|---|---|
| `join_game` | `{room_id, handle, token}` | This socket has the table's game open, as `handle`. `token` is the `presence_token` from that player's GameView; anything else is ignored |
| `leave_game` | `{room_id}` | This socket closed the game (left the game page) |
| `watch_game` | `{room_id}` | This socket watches the table's game without a seat, so it is counted in `spectators`. Needs no sign-in; a socket counts at up to 5 tables |
| `unwatch_game` | `{room_id}` | This socket stopped watching (a dropped socket stops at once) |
| `open_table_chat` | `{room_id}` | This socket has the table open (its lobby or its game, seated or not) and hears its chat. Needs no sign-in; a socket has up to 5 tables open; an unknown table is ignored |
| `close_table_chat` | `{room_id}` | This socket stopped hearing the table's chat (a dropped socket stops at once) |
| `send_table_chat` | `{room_id, text}`, ack | Say `text` at the table. Acknowledged with `{ok: true}` or `{error, message}` |
| `send_table_reaction` | `{room_id, reaction}`, ack | React at the table, `reaction` one of `wow`, `clap`, `party`, `fire`, `laugh`, `heart`, `love`, `cry`, `angry`, `high_five`, `fist`, `cool`. Acknowledged like `send_table_chat` |

**Table chat is public.** A message is `{id, author: {handle, name}, text, at}`, where `author` is the signed-in
account of the socket that sent it and `at` an ISO time. Every message and reaction goes to the whole table: there is
no private or direct message between players (so nobody can pass hints about their hand), and fields other than
`room_id` and `text` / `reaction` are ignored. The text is one line, at most 200 characters, with runs of whitespace
collapsed. Errors: `NOT_SIGNED_IN` (only signed-in accounts speak; anyone with the link reads), `NOT_AT_TABLE` (send
`open_table_chat` first), `EMPTY`, `TOO_LONG`, `UNKNOWN_REACTION`, `TOO_FAST` (more than 8 messages, or 8 reactions, in
10 seconds). The chat is kept in memory, so it starts empty again after a restart.

No other client → server events are handled. For the legacy game there are no events, so clients must re-fetch
`/board/deck` and `/game/hand_cards` themselves.

## Static assets

Card images: `GET /images/card_deck/Cards-<name>.svg`, where `<name>` is a card name (`10-Heart`, `J-Spade`,
`Blank`), plus `Cards-Reverse.svg` (card back) and three joker images that the game never uses.
