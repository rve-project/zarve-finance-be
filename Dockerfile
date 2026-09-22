# --- deps ---
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- build ---
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
# tsc only compiles .ts -- migrate.js reads its .sql files from alongside itself at
# runtime, so copy them into dist/migrations the same way tsc laid out everything else.
RUN mkdir -p dist/migrations && cp src/migrations/*.sql dist/migrations/

# --- runtime ---
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

EXPOSE 4001
CMD ["node", "dist/server.js"]
