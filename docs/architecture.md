# Architecture

## Stack

Node.js, Express `~4.16`, Better Auth 1.7 (accounts and sessions in PostgreSQL), `express-rate-limit`, `socket.io` (declared as `latest`, locked
to 2.3.0 by `package-lock.json`), PostgreSQL 16 through `pg` (plain SQL, no ORM), Jest for tests. CommonJS
modules, no build step, no TypeScript.

## Run

The whole development environment (PostgreSQL, this backend, and the frontend from the sibling
`../sequence-board-game-frontend` checkout) runs with Docker:

```bash
docker compose up            # frontend http://localhost:5173, backend http://localhost:3000, Postgres :5432
docker compose up db         # only Postgres, then run the backend on the host (below)
docker compose down -v       # stop everything and delete the database volume
```

Both app containers mount their source and reload on change (nodemon, Vite). They install dependencies with
`npm ci` into a container-only volume on each start, so the host's `node_modules` is not used. Change the host
ports with `DB_PORT`, `BACKEND_PORT`, `FRONTEND_PORT` (for example in a `.env` file next to `docker-compose.yml`).

On the host (needs Postgres, for example `docker compose up db`):

```bash
npm install
npm start            # node ./bin/www, applies migrations, listens on PORT or 3000
npm test             # jest; the database tests run only when DATABASE_URL is set
DATABASE_URL=postgres://sequence:sequence@localhost:5432/sequence npm test
npm run db:migrate   # apply pending migrations without starting the server
npm run db:seed      # create the development accounts jabir/1 and sakib/123 (compose does this itself)
npm run dev          # nodemon
npm run debug_1      # terminal game, moves read from console_controller/input.txt
npm run debug_2      # terminal game, moves typed interactively (inquirer)
```

## Database

`DATABASE_URL` (default `postgres://sequence:sequence@localhost:5432/sequence`, the compose database) configures
the shared pool in `database/pool.js`. On boot, `bin/www` applies pending migrations and refuses to start if the
database is unreachable.

Migrations are plain SQL files in `database/migrations/`, applied in file name order, once each, by
`database/migrate.js`. Applied names are recorded in the `schema_migrations` table. Each file runs in its own
transaction, so a failing file leaves nothing behind, and an advisory lock serialises servers that start at the
same time. To change the schema, add the next numbered file (`0005_add_something.sql`); never edit one that has
been applied.

## Layout

```
bin/www               Applies migrations, then HTTP server, attaches Socket.IO, listens on PORT
app.js                Express app: morgan, /api/auth, JSON/urlencoded body, static public/, /health, routers
auth.js               Better Auth: accounts, sessions, email confirmation, password reset, the secret;
                      load_session puts req.user / req.handle
mailer.js             Sends account emails via Brevo's API (BREVO_API_KEY) or SMTP (SMTP_URL), else logs them
docker-compose.yml    Development environment: Postgres, backend, frontend
socket.js             Single Socket.IO server + broadcast({event, data}) to every connected socket; join_game/leave_game,
                      watch_game/unwatch_game, the table chat's events (open_table_chat, send_table_chat, ...)

routes/               Thin routers: auth (Better Auth + rate limits), user, room, game, board
controller/
  user.js             profile and stats, avatars, the user's rooms and current game (JSON errors)
  room.js             create / get / join room, change its settings (host only), broadcasts room_updated
  room_game.js        start a table's game, view it, play / exchange / pass; broadcasts game_updated; turn timer,
                      pauses the turn of a player who is away from the table; plays the bots' turns
  matchmaking.js      The Quick Match queue (in memory): seats matched players, with bots after a 2 minute wait
  presence.js         In memory: which seated players have their table's game open (signed socket tokens)
  spectators.js       In memory: how many sockets watch each table's game without a seat (watch_game)
  table_chat.js       In memory: each table's public chat (last 50 messages) and quick reactions; no private messages
  board.js            serves data/board_deck.json (module singleton, also used as live board state)
  game.js             LEGACY global game: 4 hard-coded players, deal on module load, play endpoint
  index.js            Dead code (unattached socket.io instance, unused inquirer controller)
database/
  pool.js             PostgreSQL connection pool (DATABASE_URL) and ping() for /health
  migrate.js          SQL migration runner (also `npm run db:migrate`), tested in migrate.spec.js
  migrations/         Numbered .sql files (0012 user_avatars): 0001 users, 0002 session, 0003 rooms + room_seats, 0004 games + turns,
                      0005 room names, slug codes and settings, 0006 game mode (dropped in 0016),
                      0007 highlights and history off by default, 0008 turn timer,
                      0009 turn deadlines, 0010 dead card settings, 0011 Better Auth tables, 0013 game rounds,
                      0016 drops the retired game mode, 0017 leaderboard ratings, 0018 bots, matchmaking
                      tables and their leaderboard, 0019 bot names, 0020 quick match forfeits, 0022 friendships
                      and table invitations, 0023 letting friends watch (off by default), 0027 the blitz clock
  users.js            Reads accounts (Better Auth writes them), their game stats, and stores avatars
  seed.js             Development accounts jabir/1, sakib/123 (`npm run db:seed`)
  test_database.js    Gives a spec its own migrated schema (needs DATABASE_URL)
  rooms.js            Rooms and seats; join() takes a seat under a room lock; list_for_user() for history
  games.js            Table game state (JSONB) and the turns history; kept apart so room payloads never carry hands
  leaderboard.js      The all-time, weekly and daily leaderboards, read from the ratings 0017 keeps (or, for
                      Quick Match, 0018); each limited to one player's friends, or everyone's
  friends.js          Friendships (one row per pair), searching players, and invitations to tables
entity/               Domain layer (tested)
  user.js             Handle and display name rules, scrypt password hashing
  emails.js           Account emails: confirmation, password reset, password changed, already registered,
                      approving a new email
  avatar.js           Which avatar uploads are accepted (PNG, JPEG, WebP by their bytes, 256 KB)
  room.js             Room names, slug codes and settings (defaults and parsing)
  rounds.js           A round's statistics from its final state, and the final summary and verdict of all rounds
  sequence_game.js    Full rules for table games: dealing, turns, jacks, dead cards, sequences, win. Wired to HTTP
  bot.js              The bot's move: one move ahead, scored by the board's 5-cell windows
  matchmaking.js      The Quick Match queue's rules: table shapes, matching, the bot timeout, stale entries
  board.js            New_board(): get_deck, play, pretty_deck; move validation
  players.js          create_players({teams}): seating order, hands, team/player count validation
  game.js             initialize_game({teams}): board + players + shuffled deck + deal
use_case/game.js      start({teams, controller}): turn loop (play, draw, next player)
console_controller/   Terminal adapter: reads moves from input.txt
console_controller_2/ Terminal adapter: interactive prompts
data/
  board_deck.json     10×10 grid of {name}, see game-domain.md
  game_deck.json      104 cards (two 52-card decks, no jokers) as {name}
public/               Old Vue 2 prototype UI (index.html, views/, javascripts/) + card SVGs
```

## Three game implementations

| | `entity/sequence_game.js` | `entity/` + `use_case/` | `controller/game.js` |
|---|---|---|---|
| Used by | HTTP table games (`/room/:id/start`, `/room/:id/game/*`) | Terminal runners and tests | Legacy HTTP API (`/game/*`) |
| Players | A room's seats | From the `teams` argument | Hard-coded: jabir, sakib (`team1`), habiba, humaira (`team2`) |
| Dealing | Official counts by player count | Official counts by player count | 5 cards each |
| Turn order | Enforced | Enforced, teams alternate | None |
| Draw after play | Yes, reshuffles the discard pile | Yes | Yes |
| Sequences / win / dead cards | Yes | No | No |
| Board state | Per-game, immutable updates, stored in PostgreSQL | Per-game copy | Mutates the shared `data/board_deck.json` module, which `/board/deck` returns |

The `use_case` loop talks to the outside world through a controller object:
`next_move() → {hand_card_index, row, column} | undefined` (undefined ends the game),
`broadcast_board({board})`, `log({message})`, `error({message})`. A web adapter could implement the same interface.

## State and lifetime

Accounts, sessions, rooms, seats, table games and their turns are stored in PostgreSQL and survive restarts.
Who is at each table (`controller/presence.js`) is also in memory: after a restart every player is away, and
their turn waits, until their game page reconnects. So is each table's chat (`controller/table_chat.js`), which
starts empty after a restart. Only the legacy developer game is still in memory and lost on restart (dealt once when
`controller/game.js` is first required, at server start), and the board. There is one global HTTP game for
the whole server, not one per room.

## Rooms, games and history

| Table | One row per | Notes |
|---|---|---|
| `rooms` | table | Code (`id`, a slug of the name such as `friday-night-k3m9`; older rooms have numeric codes), name, creator, team layout, settings (`history_enabled`, `highlights_enabled`, `auto_draw_dead`, `turn_seconds`, `clock_seconds`), creation time |
| `room_seats` | taken seat | Primary key (room, team, seat) and unique (room, user): one player per seat, one seat per player. Rows can be removed (standing up, reshuffling) only until the game starts; after that they are the room's history |
| `games` | round of a room's game | Round number (the highest is the table's current game), full rules state as JSONB (hands and deck included, so only `view_for()` output is ever sent), started / updated / finished time, winning team, the round's statistics once won |
| `player_ratings` | player with a won round | Elo rating (from 1200), rounds played and won; the all-time leaderboard |
| `game_results` | player in a won round | Append-only: team, won, rating before and the change; the weekly and daily leaderboards sum these |
| `matchmaking_ratings`, `matchmaking_results` | as the two above, for Quick Match rounds | The Quick Match leaderboard, kept apart |
| `friendships` | pair of players | Who asked whom, `pending` or `accepted`; one row per pair whichever way (a unique index on the ordered pair). Declining, cancelling and unfriending delete it. The `friend_links` view lists accepted ones from both sides |
| `table_invitations` | friend asked to a table | Table, invitee, inviter, time. Gone when the invitee sits down there, dismisses it, or the two stop being friends |
| `turns` | accepted move in a round | Append-only: move number, game turn, player, team, kind, card, cell, and the log events the move produced |

A move is one transaction in `controller/room_game.js`: read the game `FOR UPDATE`, apply the rules
(`entity/sequence_game.js`), then `record_move()` saves the new state and appends the turn. A rejected move
changes nothing, and moves on one table can't interleave. Joining and starting lock the room row the same way.

Settings can change (by the room's creator) until the game starts, then they are fixed. Rules that change play
(`auto_draw_dead`) are also copied into the game state's `rules` when it is dealt, so a resumed game always plays by
the rules it started with. Display settings (`history`, `highlights`) are read from the room for every GameView. There are no game modes or
hints: training tables were retired (0016), and learning the rules is the frontend's interactive training. A `mode`
sent by an older client is ignored. Only the host can start the game.
With history off, `turns` is still written (the "Your tables" move count uses it) but never served.

The rules engine has no clock: `controller/room_game.js` stamps `turn_started_at` into the stored state whenever
a new turn begins (an exchange keeps the turn and its time), so turn timers survive restarts too.

Each game also stores `turn_deadline` (the turn's start plus the room's `turn_seconds`). `bin/www` starts a sweeper
(`start_turn_timer()` in `controller/room_game.js`) that checks once a second for games past their deadline and plays
a random card for the current player (`random_move()`), in the same locked transaction as a normal move. It re-checks
the deadline inside the transaction, so a move made just in time wins. The app itself doesn't start the sweeper, so
tests drive it with `expire_overdue_turns()`. Games resumed after a restart keep their deadlines.

Blitz (`clock_seconds`, 0027) swaps the per-turn timer for a chess-style clock. Each round's state starts with
`clocks`, every team's time in ms; when a turn ends `stamp_turn()` charges its running time (paused time aside) to its
team, and the deadline becomes the turn's start plus what its team has left. A team out of time gets a deadline equal
to its turn's start, so the sweeper plays for it at once, every turn, until the round ends. Bots spend at most a
twentieth of their clock thinking.

A table plays its game in rounds. Once a round is won, its statistics (`entity/rounds.js`) are saved with the
winning move, and the host deals the next round as a new `games` row with the same teams (seats stay fixed) or ends
the rounds (`rooms.rounds_ended_at`), after which the GameView carries the final summary of every round. A player's
profile stats count rounds: each won round is a game played.

The winning move also rates the round for the leaderboard: `record_move()` calls the SQL function
`record_game_result()` (migration 0017) in the same transaction. It is team Elo with K = 32: a team's rating is its
players' average, the winner beats each losing team and each loser loses to the winner (with three teams each result
counts half), and every player of a team moves by the same whole number of points, saved in `game_results`. The
function ignores a round it already rated, and the migration ran it over every round won before, oldest first.
`database/leaderboard.js` ranks all time by rating (`player_ratings`, indexed in board order) and the last 7 days /
24 hours by the rating gained in them; ties share a rank and are ordered by wins, then account age.

Players see the **friends** board: the same standings limited to them and their friends (`friend_links`), ranked
among those players alone, so nobody they aren't friends with is ever listed. The global board's code is kept: it is
served (as `scope=global`) only when the `GLOBAL_LEADERBOARD` setting is `on` (`controller/user.js`; `render.yaml`
sets it `off`), and the response's `scopes` tells the frontend whether to offer it.

### Friends and invitations

`controller/friends.js` serves `/friends/…` and `POST /room/:id/invite`. Requests and invitations are delivered over
Socket.IO only to the player concerned: when a socket connects, `socket.js` reads the session cookie its handshake
carried, joins it to the room `user:<handle>`, and counts the player online (`controller/online.js`, in memory, so the
friends list can say who has the app open). `send_to()` emits there; the frontend reconnects its socket after signing
in or out so the handshake carries the current cookie. Everything else stays a broadcast.

Everything a client needs to resume is in these tables: who sat where, the settings, and the full game state.
After a restart, `GET /user/rooms` lists a player's tables and `GET /room/:id/game` returns the game as it was.

The game state also carries its own `log`, which the GameView shows; `turns` is the queryable history of the same
moves, keyed to user ids rather than display names.

## Quick Match and bots

`controller/matchmaking.js` keeps one queue per table shape: 2 or 3 teams of one player (so nobody shares a team with
a stranger) and a timer (fast 15 s, medium 45 s or slow 90 s per turn, or blitz: a 5 minute clock each); everything else is a new table's default. When as
many players as teams wait for the same shape, the oldest are matched; once the oldest has waited two minutes, they
are matched with whoever else waits and bots take the other seats (`entity/matchmaking.js`). The queue lives in memory
(one server), so a restart empties it, and waiting pages check in every few seconds: an entry not seen for 30 seconds
is dropped, so nobody is seated at a game they've closed. A player with a quick match in progress is sent back to it
rather than queued.

A match is an ordinary room with `rooms.matchmaking` set: seated in random team order and dealt at once, by
`deal_first_round()` in `controller/room_game.js`. It differs from a private table in three ways. Its turns never pause
for an absent player (the timer plays for them), the first turn has 10 seconds' grace for everyone to open the game,
and it plays a single round: the winning move ends the rounds. Its won round is rated by `rate_round()` (0018) into
`matchmaking_ratings` / `matchmaking_results` rather than the private tables' leaderboard, so the two never affect each
other.

Bots are accounts (`users.is_bot`, made by 0018) with no password and `@bots.invalid` emails that are never sent
anything. They pass for players: 0019 gave them everyday names and handles, and nothing a client is sent marks a seat
as a bot's (game views, room payloads and `match_found` treat every seat alike, and the queue status doesn't say when
bots would come). A seated bot is marked `bot: true` in the stored game state only. `start_bot_players()` (started by
`bin/www`, like the turn timer) looks for games where a bot is to move and, once it has "thought" for 1.5 to 7
seconds (varied each turn), plays its whole turn in the same locked transaction a player's move uses. The move comes from
`entity/bot.js`: every card on every legal cell, scored by the board's 5-cell windows, where a window still open to a
team is worth more the more of its cells the team holds (one short of a winning sequence most of all). A move scores
what it adds to the bot's windows plus what it takes from every opponent's, with bonuses for completing a sequence and
for winning. Jacks have a cost, so wild jacks are saved for completing or blocking lines and one-eyed jacks for breaking
an opponent's near-sequence; a dead card is exchanged first. Bots are rated on the Quick Match leaderboard, so beating
one counts, but they are never listed.

A quick match player may forfeit (`POST /room/:id/game/forfeit`), and does automatically after the timer has played
for them 10 turns in a row (`missed` in the state counts them; a move of their own resets it). The seat gets
`room_seats.forfeited_at` (0020) and the handle goes into the state's `forfeited`. With two teams the other team wins
at once and the round is rated as usual. With three, `record_matchmaking_forfeit()` takes the forfeiter's rating loss
at once, and a free bot plays the seat on under the forfeiter's name (`played_by` in the state; its moves are its own in
`turns`). `record_matchmaking_result()` then rates nobody if that seat wins, and otherwise leaves out whoever was
already rated by a forfeit.

## Accounts and sessions

[Better Auth](https://better-auth.com) (`auth.js`) runs accounts and sessions in our PostgreSQL, with its tables
mapped onto ours: `users` (its `user`; the handle is the username plugin's `username`, and ids stay the BIGINT that
rooms reference), `auth_accounts` (the password hash), `auth_sessions` and `auth_verifications`. Migration 0011
created them from the earlier `users` and `session` tables, keeping every account and password.

Cookie `sequence.session_token`: HttpOnly, `SameSite=Lax`, `Secure` when `BETTER_AUTH_URL` is HTTPS. It holds a
signed token for a row in `auth_sessions`, which expires after 7 days without use (each day of use extends it) and
is deleted by sign-out. `load_session` (in `auth.js`) looks the session up for `/user`, `/room`, `/game` and `/board`
and passes on the refreshed cookie when Better Auth extends it. There is no CORS middleware, and Better Auth refuses
`POST`s from origins other than `BETTER_AUTH_URL`, so a frontend on another origin needs a same-origin proxy (the
frontend's Vite dev server is one).

Passwords are hashed with scrypt (`entity/user.js`), which Better Auth is given in place of its own. The hash string
records its salt and cost parameters, so the cost can be raised without breaking existing accounts. Sign-in and
sign-up are rate limited per client IP in memory (`routes/auth.js`, see [api.md](api.md#accounts-better-auth));
limits reset when the server restarts. Better Auth adds its own limits in production.

New accounts confirm their email before they can sign in: a hook on every new session (`require_verified_email`)
refuses accounts with an unconfirmed address and emails a fresh link. Accounts made before emails were asked for have a
`<handle>@no-email.invalid` placeholder, which can't receive mail, so they are let in and never emailed. Better Auth's
own `requireEmailVerification` can't make that exception. Password reset links work once, for an hour; a reset signs
out every device. Emails go out in the background, so the answer (and its timing) never shows whether an address has
an account. Without `BREVO_API_KEY` or `SMTP_URL` they are printed to the server log, which is how to get the links in development.

Players manage their account from the frontend's profile page: display name, email and password through Better Auth,
avatars through `/user/avatar`. Avatars are stored in PostgreSQL (`user_avatars`, a few kilobytes each after the
frontend shrinks them), so there is no file storage to run; `users.image` holds the versioned URL that serves the
current one. Handles never change, since games and socket tokens refer to players by handle.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | the compose database on localhost | PostgreSQL connection |
| `SESSION_SECRET` | a fixed development value | Signs session cookies, emailed links and socket tokens (`BETTER_AUTH_SECRET` also works). **Required** when `NODE_ENV=production` |
| `BETTER_AUTH_URL` | `http://localhost:5173` | The address players open: emailed links point here, other origins are refused. **Required** when `NODE_ENV=production` |
| `REDIRECT_HOSTS` | none | Comma-separated host names that redirect (`308`, same path) to `BETTER_AUTH_URL`, e.g. an old address. `/health` is not redirected |
| `BREVO_API_KEY` | none | Sends account emails through Brevo's API over HTTPS (for hosts that block SMTP, like Render's free tier) |
| `SMTP_URL` | none: emails are logged | SMTP server for account emails when there is no `BREVO_API_KEY`, e.g. `smtps://user:password@smtp.example.com:465` |
| `MAIL_FROM` | `Sequence <no-reply@sequence.invalid>` | Sender of account emails; use an address the SMTP service lets you send from |
| `TRUST_PROXY` | off | Express `trust proxy` (e.g. `1`), so rate limits see client IPs behind a reverse proxy |
| `PORT` | `3000` | HTTP port |
