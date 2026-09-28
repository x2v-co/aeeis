FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends bash git curl ca-certificates procps tini \
    && rm -rf /var/lib/apt/lists/*
COPY --chmod=0444 runner.py service.py client.py /opt/aeeis/
RUN mkdir -p /workspace/artifacts
WORKDIR /workspace
# Root inside a normal isolated container permits apt/pip and service setup.
# No host mounts, Docker socket, privileged mode or host namespaces are used.
ENTRYPOINT ["/usr/bin/tini", "--", "python3", "-I", "-u", "/opt/aeeis/service.py"]
