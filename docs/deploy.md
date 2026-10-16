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

1. **Database.** Create a project at [neon.tech](https://neon.tech). From *Connect*, copy the connection string
   with **connection pooling turned off** (the host has no `-pooler`): migrations hold a session-level advisory lock,
   which the pooler doesn't keep. Keep `?sslmode=require` on the end.
2. **Service.** In [Render](https://dashboard.render.com), sign in with GitHub, then *New → Blueprint* and pick
   `ijabir28/sequence-board-game-backend`. Render reads [render.yaml](../render.yaml): a free Docker web service on
   branch `version-2`, health check `/health`, a generated `SESSION_SECRET`, `COOKIE_SECURE=true`, `TRUST_PROXY=1`.
3. Paste the Neon string when it asks for `DATABASE_URL`, and apply.
4. The first start applies the migrations. Open `https://<service>.onrender.com`, create an account and play a game
   from two browsers.

Don't run `npm run db:seed` against production: the development accounts have known passwords (the script refuses
when `NODE_ENV=production`, which the image sets).

## Updating

- **Backend:** pushing to `version-2` redeploys.
- **Frontend:** pushing the frontend doesn't tell Render. Redeploy with *Manual Deploy → Deploy latest commit*; the
  image picks up the frontend's latest `dev` commit. To automate it, copy the service's *Deploy Hook* URL and call it
  from a GitHub Action in the frontend repo, keeping the URL in a repository secret.

## Environment

| Variable | Set by | Purpose |
|---|---|---|
| `DATABASE_URL` | you (Neon) | PostgreSQL, direct connection |
| `SESSION_SECRET` | Render (generated) | Signs session cookies and socket presence tokens; changing it signs everyone out |
| `COOKIE_SECURE` | render.yaml | Cookies only over HTTPS |
| `TRUST_PROXY` | render.yaml | Hops of reverse proxy in front, so the sign-in rate limit sees the client's IP |
| `NODE_ENV`, `FRONTEND_DIST` | Dockerfile | Production mode; where the built frontend is |
| `PORT` | Render | Port to listen on |

## Trying the image locally

```bash
docker build -t sequence .
docker compose up -d db
docker run --rm -p 3001:3000 --network sequence_default \
  -e DATABASE_URL=postgres://sequence:sequence@db:5432/sequence -e SESSION_SECRET=local sequence
```

Then open http://localhost:3001.
