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
# Optional build args. Empty (the default) keeps official PyPI and the Playwright CDN.
# Do not default these to a regional mirror; pass them only for a build that needs one.
# They apply to this RUN only and are not written into the image environment.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
ARG PIP_INDEX_URL=
ARG PIP_TRUSTED_HOST=
ARG PLAYWRIGHT_DOWNLOAD_HOST=
RUN set -eu; \
    if [ -n "${PIP_INDEX_URL}" ] && [ -n "${PIP_TRUSTED_HOST}" ]; then \
      pip install --no-cache-dir --index-url "${PIP_INDEX_URL}" --trusted-host "${PIP_TRUSTED_HOST}" playwright==1.49.1; \
    elif [ -n "${PIP_INDEX_URL}" ]; then \
      pip install --no-cache-dir --index-url "${PIP_INDEX_URL}" playwright==1.49.1; \
    elif [ -n "${PIP_TRUSTED_HOST}" ]; then \
      pip install --no-cache-dir --trusted-host "${PIP_TRUSTED_HOST}" playwright==1.49.1; \
    else \
      pip install --no-cache-dir playwright==1.49.1; \
    fi; \
    if [ -n "${PLAYWRIGHT_DOWNLOAD_HOST}" ]; then \
      PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST}" playwright install --with-deps chromium; \
    else \
      playwright install --with-deps chromium; \
    fi; \
    rm -rf /var/lib/apt/lists/*
COPY --chmod=0444 runner.py service.py client.py proxy.py /opt/aeeis/
RUN chmod 0755 /opt/aeeis && mkdir -p /workspace/artifacts
WORKDIR /workspace
# Root inside a normal isolated container permits apt/pip and service setup.
# No host mounts, Docker socket, privileged mode or host namespaces are used.
ENTRYPOINT ["/usr/bin/tini", "--", "python3", "-I", "-u", "/opt/aeeis/service.py"]
