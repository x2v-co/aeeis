FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json .env.example ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY fixtures ./fixtures
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/fixtures ./fixtures
RUN chmod +x /app/scripts/fixture-ownhow.mjs
RUN mkdir -p /app/data/runs && chown -R node:node /app/data
USER node
EXPOSE 4323 4324
CMD ["node", "dist/server.js"]
