# The knowledge service: one stateless container over one snapshot.
#
#   docker build -t inflexa-knowledge --build-arg SNAPSHOT=dist/snapshots/<file>.sqlite .
#   docker run -p 8790:8790 -e INFLEXA_KNOWLEDGE_SERVICE_KEY=... inflexa-knowledge
#
# R is present for the syntax check of a rendered script only. No analysis
# package is installed, because the service renders and never runs a script.

FROM oven/bun:1.3-debian

RUN apt-get update \
    && apt-get install -y --no-install-recommends r-base-core ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

COPY src ./src
ARG SNAPSHOT
COPY ${SNAPSHOT} ./dist/snapshots/snapshot.sqlite

ENV HOST=0.0.0.0
ENV PORT=8790
EXPOSE 8790
CMD ["bun", "src/service/main.ts", "--snapshot", "dist/snapshots/snapshot.sqlite"]
