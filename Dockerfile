FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json .env.example ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY fixtures ./fixtures
COPY assets ./assets
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ARG AEEIS_GIT_COMMIT=unknown
ENV AEEIS_GIT_COMMIT=${AEEIS_GIT_COMMIT}
LABEL org.opencontainers.image.revision=${AEEIS_GIT_COMMIT}
ENV NODE_ENV=production
# SSH client and CA bundle for a remote Bot sandbox (local-tools sandbox.ssh; the instabox CLI verifies TLS). Host aliases come from
# ~/.config/instabox/ssh/*.conf, written by scripts/instabox-login.sh, and from the operator's /run/aeeis-secrets/ssh/*.conf for a
# plain VPS host (deploy/stack/README.md). git is for repo-push: AEEIS commits and pushes a Bot's work itself, with a token
# the Run machines never see.
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node -m 0700 /home/node/.ssh /home/node/.config \
    && printf 'Include ~/.config/instabox/ssh/*.conf\nInclude /run/aeeis-secrets/ssh/*.conf\n' > /home/node/.ssh/config \
    && chown node:node /home/node/.ssh/config && chmod 0600 /home/node/.ssh/config
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/fixtures ./fixtures
# Noto Sans SC GB2312 subset (OFL), used only for non-Latin fillable-pdf values (~2.2 MB).
COPY --from=build --chown=node:node /app/assets ./assets
RUN chmod +x /app/scripts/fixture-ownhow.mjs /app/scripts/instabox-login.sh
RUN mkdir -p /app/data/runs && chown -R node:node /app/data
USER node
EXPOSE 4323 4324
CMD ["node", "dist/server.js"]
