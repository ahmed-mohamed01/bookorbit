FROM node:24-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ ./patches/
COPY services/novel-sources/package.json services/novel-sources/package.json
RUN pnpm install --frozen-lockfile --filter @bookorbit/novel-sources...

COPY services/novel-sources/tsconfig.json services/novel-sources/tsconfig.build.json services/novel-sources/
COPY services/novel-sources/src services/novel-sources/src
# Same reason as the root Dockerfile: only this package is installed, so pnpm must not re-install first.
RUN pnpm --config.verify-deps-before-run=false --filter @bookorbit/novel-sources build
# Mirrors the root Dockerfile: legacy deploy prunes to prod deps, and dist/ is gitignored so it is copied in after.
RUN pnpm --config.allow-unused-patches=true --filter @bookorbit/novel-sources deploy --prod --legacy /app
RUN cp -r services/novel-sources/dist /app/dist

FROM node:24-slim AS runtime

ENV NODE_ENV=production
ENV PORT=8282
WORKDIR /app

# A fixed uid/gid, so an admin who bind-mounts /data can chown the host directory to 10001:10001 before the first start.
RUN groupadd --gid 10001 novel-sources \
  && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin novel-sources \
  && mkdir /data \
  && chown novel-sources:novel-sources /data

COPY --from=build /app /app
COPY LICENSE NOTICE /app/
COPY services/novel-sources/vendor/lnreader/LICENSE /app/vendor/lnreader/LICENSE

USER 10001:10001
VOLUME ["/data"]
EXPOSE 8282
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8282)+'/api/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

# Node's permission model limits what an escaped plugin can do inside the container: it can read only the app and
# /data, write only /data, and cannot start child processes. NOVEL_SOURCES_DATA_DIR must stay /data with this command.
# Newer Node versions also gate the network behind --allow-net, a flag older versions reject, so it is added only when supported.
CMD ["sh", "-c", "exec node --permission --allow-fs-read=/app --allow-fs-read=/data --allow-fs-write=/data --allow-worker $(node --allow-net -e '' 2>/dev/null && echo --allow-net) --disable-warning=SecurityWarning --disable-warning=ExperimentalWarning dist/main.js"]
