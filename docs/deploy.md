# Deploying

The free setup: **Render** (one free web service) runs this backend, which also serves the React frontend, and
**Neon** (free PostgreSQL) holds the data. Neither needs a card.

The page, the API and Socket.IO share one origin, so the session cookie works without CORS (the backend has none),
just as the Vite proxy gives in development. The [Dockerfile](../Dockerfile) clones and builds the frontend from
GitHub (`ijabir28/sequence-board-game-frontend`, branch `dev`; build args `FRONTEND_REPO`, `FRONTEND_REF`), and the
backend serves the build from `FRONTEND_DIST`: its files, and `index.html` for every other page such as `/lobby` or
`/table/:id`.

## Free-tier limits

- The Render service **sleeps after about 15 minutes without requests**. The first visit after that waits about a
  minute while it starts. An open game keeps it awake (the socket), and turn timers pick up again after a restart.
- Neon's free database is small (about 0.5 GB), which is plenty here.

## First deploy

1. **Database.** The Neon project is linked in `neon.ts` / `.neon` (project `dry-star-85571538`, branch
   `production`). `neon deploy` applies `neon.ts` and writes the branch's connection strings to `.env.local`
   (git-ignored): `DATABASE_URL`, the pooled one (`-pooler` host) the app queries through, and
   `DATABASE_URL_UNPOOLED`, the direct one migrations use, since they hold a session-level advisory lock the pooler
   doesn't keep (`with_direct_pool` in `database/pool.js`). Without `DATABASE_URL_UNPOOLED` everything uses
   `DATABASE_URL`, as with local Postgres.
2. **Service.** In [Render](https://dashboard.render.com), sign in with GitHub, then *New → Blueprint* and pick
   `ijabir28/sequence-board-game-backend`. Render reads [render.yaml](../render.yaml): a free Docker web service in Ohio
   (next to the database), on branch `version-2`, health check `/health`, a generated `SESSION_SECRET`, `BETTER_AUTH_URL` (the service's address), `TRUST_PROXY=1`.
3. Paste `DATABASE_URL` and `DATABASE_URL_UNPOOLED` from `.env.local` when it asks, and apply.
4. The first start applies the migrations. Open `https://<service>.onrender.com`, create an account and play a game
   from two browsers.

Don't run `npm run db:seed` against production: the development accounts have known passwords (the script refuses
when `NODE_ENV=production`, which the image sets).

## Custom domain

Players open **https://sequence.fifteens.app**. The domain is registered at Name.com, where a `CNAME` record points
`sequence` at the service's `sequence-board-game-svxj.onrender.com`; Render (service → Settings → Custom Domains)
verified it and issues its certificate. `BETTER_AUTH_URL` in [render.yaml](../render.yaml) is the custom domain, so
sign-in from the `onrender.com` address is refused (`403 INVALID_ORIGIN`). Recreating the service gives it a new
`onrender.com` address: point the `CNAME` there and add the domain to the new service.

## Updating

- **Backend:** pushing to `version-2` redeploys.
- **Frontend:** pushing to `dev` runs the frontend's `.github/workflows/deploy.yml`: tests and build, then it calls the
  service's *Deploy Hook* (Render → service → Settings), kept in the frontend repo's secret `RENDER_DEPLOY_HOOK_URL`.
  The image picks up the frontend's latest `dev` commit. *Manual Deploy → Deploy latest commit* does the same by hand.
  Recreating the service gives it a new hook: update the secret.

## Environment

| Variable | Set by | Purpose |
|---|---|---|
| `DATABASE_URL` | you (Neon) | PostgreSQL for the app, pooled connection |
| `DATABASE_URL_UNPOOLED` | you (Neon) | Direct connection, for migrations |
| `SESSION_SECRET` | Render (generated) | Signs session cookies, emailed links and socket presence tokens; changing it signs everyone out |
| `BETTER_AUTH_URL` | render.yaml | The address players open; emailed links point here and other origins are refused. Update it if the service's URL changes |
| `BREVO_API_KEY`, `MAIL_FROM` | you (Render dashboard) | How account emails go out, see [Email](#email). Without them, emails only reach the service's log |
| `SMTP_URL` | optional | SMTP instead of Brevo, where outgoing SMTP isn't blocked |
| `TRUST_PROXY` | render.yaml | Hops of reverse proxy in front, so the sign-in rate limit sees the client's IP |
| `NODE_ENV`, `FRONTEND_DIST` | Dockerfile | Production mode; where the built frontend is |
| `PORT` | Render | Port to listen on |

## Email

Confirming an email and resetting a password need real email. **Render's free web services block outgoing SMTP**
(ports 25, 465 and 587 time out, logged as `Could not email … Connection timeout`), so production sends through
Brevo's email API over HTTPS instead:

1. Sign up at [Brevo](https://www.brevo.com) (free: 300 emails a day, no card).
2. *Senders, Domains & Dedicated IPs → Senders*: add the address emails come from, and confirm it from its inbox.
3. *SMTP & API → API Keys*: create a key.
4. In the Render dashboard (*Environment*), set `BREVO_API_KEY` to that key and `MAIL_FROM` to
   `Sequence <the-sender-you-confirmed@example.com>`, then save and deploy.

Without `BREVO_API_KEY`, `SMTP_URL` is used where outgoing SMTP works (a paid Render instance, your own machine), e.g.
Gmail with an *App password*: `smtps://you%40gmail.com:<app password>@smtp.gmail.com:465` (`@` in the user is `%40`).
With neither, emails only reach the service's log.

## Running locally against Neon

`.env.local` isn't loaded by `npm start` (so local work never touches production by accident); pass it explicitly:

```bash
NODE_OPTIONS=--network-family-autoselection-attempt-timeout=2000 node --env-file=.env.local bin/www
```

The `NODE_OPTIONS` part is only needed on a network without IPv6 and far from `us-east-2`: Node gives each of the
host's addresses 250 ms, an IPv4 handshake from there takes longer, and every attempt fails with `ETIMEDOUT`.
Don't run `npm run db:seed` this way: it would create the development accounts in production.

## Trying the image locally

```bash
docker build -t sequence .
docker compose up -d db
docker run --rm -p 3001:3000 --network sequence_default \
  -e DATABASE_URL=postgres://sequence:sequence@db:5432/sequence -e SESSION_SECRET=local -e BETTER_AUTH_URL=http://localhost:3000 sequence
```

Then open http://localhost:3001.
