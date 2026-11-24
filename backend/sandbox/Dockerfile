FROM node:22-bookworm-slim AS node
FROM python:3.12-slim-bookworm

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && pip install --no-cache-dir pytest==8.4.2 \
    && npm install --prefix /opt/runner --no-audit --no-fund playwright@1.58.2 \
    && rm -rf /root/.npm

ARG DEBIAN_MIRROR=https://deb.debian.org/debian
RUN sed -i "s|http://deb.debian.org/debian$|$DEBIAN_MIRROR|" /etc/apt/sources.list.d/debian.sources \
    && printf '%s\n' 'Acquire::Retries "3";' 'Acquire::http::Timeout "180";' 'Acquire::https::Timeout "180";' \
        > /etc/apt/apt.conf.d/80sandbox-download \
    && /opt/runner/node_modules/.bin/playwright install-deps chromium \
    && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/chromium
ARG CHROMIUM_SOURCE=playwright
ARG DEBIAN_SECURITY_MIRROR=https://deb.debian.org/debian-security
RUN if [ "$CHROMIUM_SOURCE" = "debian" ]; then \
        sed -i "s|http://deb.debian.org/debian-security$|$DEBIAN_SECURITY_MIRROR|" /etc/apt/sources.list.d/debian.sources \
        && apt-get update \
        && apt-get install -y --no-install-recommends chromium-headless-shell \
        && ln -s "$(command -v chromium-headless-shell)" /opt/runner/chromium \
        && rm -rf /var/lib/apt/lists/*; \
    else \
        PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=120000 /opt/runner/node_modules/.bin/playwright install --only-shell chromium; \
    fi \
    && groupadd --gid 10001 runner \
    && useradd --uid 10001 --gid 10001 --no-create-home runner \
    && mkdir /work

COPY entry.py html.cjs /opt/runner/
ENV HOME=/tmp PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /work
USER 10001:10001
ENTRYPOINT ["python", "/opt/runner/entry.py"]
