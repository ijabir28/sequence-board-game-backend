const express = require('express');
const path = require('path');
const logger = require('morgan');
const {ping} = require('./database/pool');
const {load_session, base_url} = require('./auth');


const  auth_router = require("./routes/auth");
const  user_router = require("./routes/user");
const  {room_router} = require("./routes/room");
const  {game_router} = require("./routes/game");
const  {board_router} = require("./routes/board");

const app = express();

// Behind a reverse proxy (e.g. TRUST_PROXY=1 for one hop), so req.ip is the client's address, which the
// sign-in rate limit relies on. See https://expressjs.com/en/guide/behind-proxies.html
if (process.env.TRUST_PROXY) {
    app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
}

// Old addresses of the app (REDIRECT_HOSTS, comma-separated host names, e.g. the onrender.com one after a custom
// domain took over) send players to the same page on BETTER_AUTH_URL. Sign-in only works there, since other
// origins are refused. 308 keeps the method and body, for an API call that still uses an old address. /health stays
// put, since Render's health check may come in on the old host.
const redirect_hosts = (process.env.REDIRECT_HOSTS || '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
if (redirect_hosts.length > 0) {
    const target = new URL(base_url()).origin;
    app.use(function (req, res, next) {
        if (req.path === '/health' || !redirect_hosts.includes(req.hostname)) {
            return next();
        }
        res.redirect(308, target + req.originalUrl);
    });
}

// Jest sets NODE_ENV=test; request logs would bury the test output.
if (process.env.NODE_ENV !== 'test') {
    app.use(logger('dev'));
}
// Better Auth parses its own request bodies, so it comes before the body parsers.
app.use('/api/auth', auth_router);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
// In production the built React frontend (FRONTEND_DIST, see Dockerfile) is served from here too, so the page,
// the API and the socket share one origin and the session cookie needs no CORS. It comes before `public` so
// its index.html wins over the legacy page.
const frontend_dist = process.env.FRONTEND_DIST && path.resolve(process.env.FRONTEND_DIST);
if (frontend_dist) {
    app.use(express.static(frontend_dist));
}
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', function (req, res) {
    ping()
        .then(function () {
            res.send({status: 'ok', database: 'up'});
        })
        .catch(function () {
            res.status(503).send({status: 'error', database: 'down'});
        });
});

// Who is signed in, as req.user and req.handle, for the game's own endpoints.
app.use(['/user', '/room', '/game', '/board'], load_session);
app.use('/user', user_router);
app.use('/room', room_router);
app.use('/game', game_router);
app.use('/board', board_router);

// Any other page (/lobby, /table/:id, ...) is a frontend route: hand back the app and let its router take over.
if (frontend_dist) {
    app.get('*', function (req, res, next) {
        if (!req.accepts('html')) {
            return next();
        }
        res.sendFile(path.join(frontend_dist, 'index.html'));
    });
}

module.exports = app;
