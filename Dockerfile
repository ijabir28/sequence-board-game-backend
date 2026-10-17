# Production image: this backend, serving the React frontend built from its own repo, on one origin.
# Used by Render (render.yaml); see docs/deploy.md. Local development uses docker-compose.yml instead.
#
#   docker build -t sequence .
#   docker run -p 3000:3000 -e DATABASE_URL=... -e SESSION_SECRET=... -e BETTER_AUTH_URL=http://localhost:3000 sequence

# --- Frontend: cloned and built from GitHub ---
FROM node:24-alpine AS frontend
RUN apk add --no-cache git
ARG FRONTEND_REPO=ijabir28/sequence-board-game-frontend
ARG FRONTEND_REF=dev
# The branch's current commit; it changes on every push, so the clone below is never served from the build cache.
ADD https://api.github.com/repos/${FRONTEND_REPO}/git/refs/heads/${FRONTEND_REF} /tmp/frontend-ref.json
RUN git clone --depth 1 --branch "${FRONTEND_REF}" "https://github.com/${FRONTEND_REPO}.git" /frontend
WORKDIR /frontend
RUN npm ci && npm run build

# --- Backend ---
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev
COPY . .
COPY --from=frontend /frontend/dist ./frontend-dist
ENV FRONTEND_DIST=/app/frontend-dist
USER node
EXPOSE 3000
CMD ["node", "bin/www"]
