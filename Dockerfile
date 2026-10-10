# Container image for the relay service.
#
# Service root = repository root (the Railway service must be built from the
# repo root, where this Dockerfile and pnpm-workspace.yaml live).
# There is no compile step: the `build` scripts are type-checks only, and the
# relay runs its TypeScript in place through tsx (a root devDependency), so
# devDependencies are installed on purpose.
FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app

# Pin the package manager to the version declared in package.json (pnpm@10.33.0).
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# Manifests + workspace sources first (stable layer), then install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile

# The relay reads $PORT (Railway injects it on the platform) and binds 0.0.0.0
# by default (see packages/relay/src/index.ts). No EXPOSE: the target port is
# detected by the platform.
CMD ["pnpm", "--filter", "@relay/relay", "start"]
