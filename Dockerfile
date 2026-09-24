# Study platform — single-container image.
#
# The whole app is one Node process: Express serves the REST/SSE API and the
# built SPA from the same origin, with SQLite on a volume. There is no database
# server, no cache, no object store and no external account to create — which is
# the point, and the reason this file is short.
#
# Three dependencies are native and decide the base image: `better-sqlite3`
# (the database driver), `@napi-rs/canvas` (PDF page rendering for math
# recovery) and `sqlite-vec` (the vector extension behind semantic search).
# They ship prebuilt binaries per platform+glibc, so the builder and the runtime
# MUST be the same base — a musl runtime (alpine) would load the glibc build and
# fail at require time, not at build time.

# ---- deps: production node_modules ------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Toolchain for the case where no prebuilt binary matches this platform and
# node-gyp has to compile. Present in this stage only; it never reaches runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- build: the SPA ----------------------------------------------------------
# A separate stage because `vite build` needs devDependencies that must not end
# up in the runtime image.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime -----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    # Bind all interfaces INSIDE the container. That is not an exposure
    # decision: the app's own default is 127.0.0.1 precisely so it is not
    # reachable from the LAN, and in a container that default would make it
    # unreachable from the host too. Compose publishes the port to 127.0.0.1
    # only, so the security posture is unchanged — the boundary just moved from
    # the process to the port mapping.
    HOST=0.0.0.0 \
    # The durable state. Almost everything — generated lessons, vectors, the
    # whole library — lives inside this one file.
    DB_PATH=/data/terramentor.db \
    # ...with ONE exception, and it has to be on the volume too: files whose
    # bytes are too big to want in SQLite (vault originals, the pictures and
    # audio from an imported Anki deck) are stored beside it, content-addressed.
    # Left at its default these landed in the container's own filesystem and
    # vanished on the next `--build`, while the database that references them
    # survived — a library still claiming to hold files it can no longer serve,
    # which is worse than losing both.
    #
    # NOTE the trailing backslash on the line above. A `#` mid-line is NOT a
    # comment in a Dockerfile — only a line that STARTS with one is — so an
    # inline comment here swallows the continuation, and this file spent a
    # while unable to build at all: the ENV ended early and `VAULT_ROOT=...`
    # below was parsed as an unknown instruction.
    VAULT_ROOT=/data/vault

# The commit this image was built from. There is no `.git` in the image, so
# without this the app can only report its package version — and "0.9.0" alone
# does not distinguish a release build from someone's local build of the same
# tag plus three commits. Passed by .github/workflows/release.yml; a hand build
# that omits it degrades to no commit rather than a wrong one.
ARG GIT_SHA=""
ARG BUILD_TIME=""
ENV GIT_SHA=$GIT_SHA \
    BUILD_TIME=$BUILD_TIME

COPY --chown=node:node --from=deps  /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
COPY --chown=node:node package.json ./

# Run unprivileged. `node` (uid 1000) ships with the base image; /data is chowned
# so the volume is writable when Docker creates it empty on first run.
#
# Ownership is set on each COPY rather than by a `chown -R` afterwards: a
# recursive chown rewrites every file it touches into a NEW layer, which for
# node_modules meant ~185s of build time and a second full copy of the
# dependency tree in the image.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3001

# Uses the runtime's own fetch rather than curl/wget, neither of which is in the
# slim image — installing a package purely to answer "is it up" is not worth an
# extra layer.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
