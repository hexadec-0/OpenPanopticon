# SPDX-License-Identifier: GPL-3.0-or-later
#
# OpenPanopticon container image. Every setting from .env.example is read from
# the environment, so configure it with `docker run -e`, a compose file, or the
# Env tab in Portainer. See DOCKER.md.

FROM node:22-alpine

# A container is reached through its published port, never its own loopback,
# so it listens on every interface. The server then requires ALLOWED_HOSTS and
# an ACCESS_KEY (see DOCKER.md); nothing about that check is relaxed here.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8420 \
    OPENPANOPTICON_DATA_DIR=/data

WORKDIR /app

# The app has no runtime dependencies, so there is no npm install step.
COPY package.json server.js ./
COPY public ./public
COPY docker/healthcheck.cjs ./docker/healthcheck.cjs

# The response cache and TLE copies live on a volume so they survive upgrades.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 8420

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "docker/healthcheck.cjs"]

# node runs as PID 1 and server.js handles SIGTERM, so `docker stop` is clean.
CMD ["node", "server.js"]
