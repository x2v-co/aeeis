FROM node:22.11.0-bookworm-slim AS node

FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends bash git curl ca-certificates procps tini \
    && rm -rf /var/lib/apt/lists/*
# Node.js for web projects, copied from the official image (same Debian release).
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack
# Headless Chromium for the browser tool.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN pip install --no-cache-dir playwright==1.49.1 \
    && playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*
COPY --chmod=0444 runner.py service.py client.py proxy.py /opt/aeeis/
RUN chmod 0755 /opt/aeeis && mkdir -p /workspace/artifacts
WORKDIR /workspace
# Root inside a normal isolated container permits apt/pip and service setup.
# No host mounts, Docker socket, privileged mode or host namespaces are used.
ENTRYPOINT ["/usr/bin/tini", "--", "python3", "-I", "-u", "/opt/aeeis/service.py"]
