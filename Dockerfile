# syntax=docker/dockerfile:1.7
#
# Root multi-stage Dockerfile for the Microservice Scaffold.
#
# Builds a Container image that ships the Overseer plus a selected set of
# microservices. The MICROSERVICES build argument is the selector (Requirements
# R6.1/R6.2): `*` (the default) ships every discovered microservice (a
# Generic_Container); a comma-separated list ships only those identifiers (a
# Specific_Container).
#
# Stages:
#   build   - install every workspace from the committed lockfile, then run
#             build-tools' build-image-tree: generate the registry for the
#             selector, compile ONLY the selected projects, drop
#             devDependencies, and assemble the staging tree at /out.
#             Runs on $BUILDPLATFORM (native speed, no emulation).
#   runtime - minimal node:22-alpine image on the TARGET platform whose entire
#             application payload is a single copy of /out. dumb-init as PID 1;
#             runs as the unprivileged `node` user.
#
# The image ships only what was built, by construction — nothing is deleted
# after the fact. /out looks like this:
#
#   node_modules/                       third-party runtime deps only
#   node_modules/@scaffold/contracts/   real directory: package.json + dist
#   node_modules/@scaffold/<selected>/  real directories, selected services only
#   packages/overseer/                  package.json + dist
#
# Microservices live only under node_modules/@scaffold/ because the generated
# registry imports them by package name; packages/microservices/ is absent from
# the image. Adding a microservice therefore requires NO change to this file.
#
# NOTE: native-module limitation. `npm ci` runs on $BUILDPLATFORM, so native
# addons (if any) are compiled for the build host architecture. The current
# scaffold has no native dependencies (Express is pure JS), so this is fine.
# If a microservice introduces a native dependency, the Dockerfile would need
# a separate target-platform deps stage that re-installs production deps for
# the correct arch.
#
# R6.6 note: the per-microservice default-toggle ENV lines
# (MICROSERVICE_<X>_ENABLED=enabled) are injected into a generated
# `Dockerfile.effective` by scripts/emit-effective-dockerfile.sh, which anchors
# on the last ENTRYPOINT instruction below.

# Placeholder selector: overridden per build via `--build-arg MICROSERVICES=...`.
ARG MICROSERVICES=*

# Base-image version pins: overridable via --build-arg without touching this
# file. Defaults match the versions the CI workflow forwards.
ARG NODE_VERSION=22
ARG ALPINE_VERSION=3.21

# ---------------------------------------------------------------------------
# Stage: build - install, generate, compile, prune, assemble /out.
# Runs on the BUILD platform (native speed, no emulation for tsc / npm ci).
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS build
WORKDIR /app

ARG MICROSERVICES
ENV MICROSERVICES=${MICROSERVICES}

# All sources at once: no per-package manifest enumeration to keep in step with
# the workspace list. The npm cache mount below is what keeps rebuilds fast.
# .dockerignore keeps host node_modules/, dist/ and generated code out of the
# context, so this install and build are deterministic.
COPY . .

RUN --mount=type=cache,target=/root/.npm npm ci --workspaces --include-workspace-root

# build-tools is compiled first (alongside contracts, which the registry it
# emits imports and which is not a project reference of it), then it assembles
# the image tree.
# Everything else — registry generation, the selective tsc build, pruning
# devDependencies, staging /out — happens inside build-image-tree.
RUN npx tsc --build packages/contracts packages/build-tools \
  && node packages/build-tools/dist/bin/build-image-tree.js

# ---------------------------------------------------------------------------
# Stage: runtime - minimal image that runs the Overseer.
# Runs on the TARGET platform (the default, no --platform override).
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS runtime

RUN apk add --no-cache dumb-init

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# The whole application payload, exactly as staged by the build stage.
COPY --from=build /out ./

# --- R6.6 toggle-default ENV injection marker ---
# scripts/emit-effective-dockerfile.sh inserts one
#   ENV MICROSERVICE_<IDENTIFIER>_ENABLED=enabled
# line per resolved identifier here (in Dockerfile.effective), before ENTRYPOINT.

EXPOSE 8080
USER node
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "packages/overseer/dist/index.js"]
