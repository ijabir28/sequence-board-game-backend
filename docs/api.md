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
`200 {handle, name, email, email_verified, image, created_at, stats: {played, won, playing}}`, or
`401 NOT_SIGNED_IN`. Clients can use it to ask "am I signed in?". `email` is `null` for accounts made before emails
were asked for; `image` is the avatar's URL or `null`. `stats` counts the table games the player has a seat in:
finished (`played`), won by their team (`won`) and in progress (`playing`).

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
  "settings": {"mode": "standard", "history": false, "highlights": false, "auto_draw_dead": false, "turn_seconds": 90, "dead_cards": "manual", "exchanges_per_turn": null},
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

## Room

Rooms, seats, games and every move are stored in PostgreSQL, so tables and games in progress survive restarts.

### `POST /room/create` (auth)
Body `{number_of_team, number_of_player_in_each_team, name?, mode?, history?, highlights?, auto_draw_dead?,
turn_seconds?, dead_cards?, exchanges_per_turn?}`. Counts are numbers or numeric strings; `mode` is `"standard"` or
`"training"`; `turn_seconds` is a whole number from 15 to 600; `dead_cards` is `"manual"` or `"indicator"`;
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
| `mode` | `"standard"` | `"training"`: the player whose turn it is gets a `hint` in the GameView. Standard games never get hints |
| `history` | `false` | Off: `GET /room/:id/turns` is `403 HISTORY_DISABLED` and the GameView's `log` keeps only the latest move |
| `highlights` | `false` | Off: clients don't light up legal cells (the server only reports the setting) |
| `turn_seconds` | `90` | Seconds each player has for a turn. Clients offer 30, 60, 90, 120 and 180, or any whole number from 15 to 600 |
| `dead_cards` | `"manual"` | `"manual"`: nothing marks dead cards; players spot them and ask to exchange them, and the server refuses a card that isn't dead (`NOT_DEAD`). The GameView's `can_exchange` is then true whenever the current player has exchanges left, so it never gives a dead card away. `"indicator"`: clients mark dead cards in the hand, and `can_exchange` is true only when one is there |
| `exchanges_per_turn` | `null` (unlimited) | How many dead cards a player may exchange in one turn: `null` for unlimited, or 1 to 10. Rooms created before this setting allow 1 |
| `auto_draw_dead` | `false` | With `dead_cards: "indicator"` only. On: dead cards are exchanged automatically when their owner's turn starts (as many as `exchanges_per_turn` allows, counted as theirs), logged as `{kind: "exchange", auto: true, …}` |

Room codes created before slugs are numeric strings (`"731791746123232"`) and still work.

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
  "settings": {"mode": "standard", "history": false, "highlights": false, "auto_draw_dead": false, "turn_seconds": 90, "dead_cards": "manual", "exchanges_per_turn": null},
  "created_at": "2026-10-15T05:48:22.696Z",
  "teams": [
    { "handle": "TEAM_1", "players": [ {"handle": "jabir", "name": "Jabir ibne kamal"}, null ] },
    { "handle": "TEAM_2", "players": [ null, null ] }
  ],
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
- `{"message": "ROOM_NOT_FOUND"}` or `{"message": "TEAM_NOT_FOUND"}`.

Joins to the same room are serialised, so a contested last seat goes to exactly one player.

### `POST /room/:id/leave` (auth)
Stand up from your seat before the game starts, to take another seat or let the host reshuffle the teams.
`200` with the Room, and `room_updated` is broadcast. JSON errors: `401 NOT_SIGNED_IN`, `404 ROOM_NOT_FOUND`,
`409 NOT_SEATED` (you have no seat here), `409 GAME_ALREADY_STARTED` (seats are fixed once the game starts).

### `POST /room/:id/shuffle` (auth, host)
Deals the seated players out to the seats at random before the game starts, keeping teams as even as possible
(seat 1 of every team first, then seat 2, …). `200` with the Room, and `room_updated` is broadcast. `401`, `403
NOT_HOST`, `404 ROOM_NOT_FOUND`, `409 GAME_ALREADY_STARTED`. To list your rooms, see [`GET /user/rooms`](#get-userrooms-auth).

## Table game

A full game for a room, run by the server (`entity/sequence_game.js`). Errors are JSON `{error, message}`, where
`message` is readable by players: `401 NOT_SIGNED_IN`, `403 NOT_A_PLAYER | NOT_HOST`, `404 ROOM_NOT_FOUND | GAME_NOT_FOUND`,
`409 GAME_ALREADY_STARTED | TABLE_NOT_FULL | NOT_YOUR_TURN | GAME_OVER | ROUND_IN_PROGRESS | ROUNDS_OVER`, and `400` for rule errors (`CELL_MISMATCH`,
`CELL_OCCUPIED`, `CORNER`, `OWN_CHIP`, `LOCKED_CHIP`, `NOT_DEAD`, `HAS_MOVES`, …).

### `POST /room/:id/start` (auth)
Deals a game once every seat is taken. Only the table's creator (the host, `administrator`) may start it; anyone
else gets `403 NOT_HOST`. Seats alternate
teams (T1, T2, [T3,] T1, …), and the first seat moves first. Returns a GameView and broadcasts `room_updated` and
`game_updated`.

The game is played in **rounds**. `start` deals round 1; once a round is won, the host either deals another round
with the same teams ([`POST /room/:id/rounds/next`](#post-roomidroundsnext-auth-host)) or ends the rounds there
([`POST /room/:id/rounds/end`](#post-roomidroundsend-auth-host)), which gives the table its final result. The GameView
is always the current (latest) round's, with every won round's statistics in `rounds`.

Moves on one table are applied one at a time: of two simultaneous moves by the current player, the second
gets `409 NOT_YOUR_TURN`. Every accepted move is recorded (see [`GET /room/:id/turns`](#get-roomidturns)).

### `GET /room/:id/game`
The GameView for the session's user. Anyone may watch; only seated players see a hand (their own).

```jsonc
// GameView
{
  "team_count": 2, "sequences_to_win": 2,
  "players": [{"handle": "jabir", "name": "Jabir ibne kamal", "team": 0, "hand_count": 7}, …],
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
  "rounds": {…},                     // the table's rounds, see below
  "hint": null,                      // training games only, for the current player, see below
  "turn_started_at": "2026-10-15T06:55:15.349Z",   // when the current turn began (null for games stored before)
  "turn_deadline": "2026-10-15T06:56:45.349Z",     // when the turn's timer runs out (null once the game is over or while paused)
  "turn_paused": false,              // the current player is away from the table, so their turn waits for them
  "turn_time_left_ms": null,         // while paused: the time the current player will have left; else null
  "away": ["sakib"],                 // seated players whose game page isn't open
  "presence_token": "q9…",           // seated players only: send it with the socket's join_game (null for spectators)
  "server_time": "2026-10-15T06:55:21.002Z",       // the server's clock now, to run a turn timer despite clock skew
  "settings": {"mode": "standard", "history": false, "highlights": false, "auto_draw_dead": false, "turn_seconds": 90, "dead_cards": "manual", "exchanges_per_turn": null},
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

`hint` is null except for the player whose turn it is in a training game, where it is the suggested move
(`entity/hints.js`):

```jsonc
{"type": "play", "hand_index": 2, "target": {"row": 3, "column": 5}, "reason": {"kind": "block", "length": 5, "team": 1}}
{"type": "exchange", "hand_index": 0, "reason": {"kind": "dead"}}
{"type": "pass", "reason": {"kind": "pass"}}
```

`reason.kind` is `sequence` (completes one), `extend` (builds your line to `length`), `block` (takes the cell that
would give `team` a line of `length`), `break` (a one-eyed jack breaking `team`'s line of `length`), `dead` or `pass`.

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

### `POST /room/:id/game/play` (auth) — body `{hand_index, row, column}`
### `POST /room/:id/game/exchange` (auth) — body `{hand_index}` (a dead card, up to `exchanges_per_turn` per turn, before playing)
### `POST /room/:id/game/pass` (auth) — only when no card can be played or exchanged

Each applies the move for the current player, draws a replacement card, and returns the new GameView. Every change
broadcasts `game_updated`.

### `POST /room/:id/rounds/next` (auth, host)
Once the current round is won, deals the next one: the same teams and seats, an empty board, a fresh deck. Returns
the new round's GameView and broadcasts `game_updated` and `room_updated`. `403 NOT_HOST`, `404 GAME_NOT_FOUND`
(nothing dealt yet), `409 ROUND_IN_PROGRESS` (the round isn't won yet), `409 ROUNDS_OVER`.

### `POST /room/:id/rounds/end` (auth, host)
Once the current round is won, ends the rounds: the GameView's `rounds.summary` then holds the final result, and no
further round can be dealt. Returns the GameView and broadcasts `game_updated` and `room_updated`. Same errors as
`rounds/next`.

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
| `room_updated` | Room (see above) | After every successful join or game start, sent to **every** connected socket |
| `teams_shuffled` | `{room_id, by: {handle, name}, room}` | After the host shuffles the teams (`room` is the new seating), so clients can tell players their new team |
| `game_updated` | `{room_id}` | After a table game starts or changes. Re-fetch `GET /room/:id/game`; the payload has no hands |
| `signed_in_elsewhere` | `{handle}` | That account signed in on a device and its other sessions were deleted. A page signed in as `handle` should re-check its session (`GET /user/profile`): the event is public, so it proves nothing by itself |

| Event (client → server) | Payload | Meaning |
|---|---|---|
| `join_game` | `{room_id, handle, token}` | This socket has the table's game open, as `handle`. `token` is the `presence_token` from that player's GameView; anything else is ignored |
| `leave_game` | `{room_id}` | This socket closed the game (left the game page) |

No other client → server events are handled. For the legacy game there are no events, so clients must re-fetch
`/board/deck` and `/game/hand_cards` themselves.

## Static assets

Card images: `GET /images/card_deck/Cards-<name>.svg`, where `<name>` is a card name (`10-Heart`, `J-Spade`,
`Blank`), plus `Cards-Reverse.svg` (card back) and three joker images that the game never uses.
