FROM node:22-bookworm-slim AS deps
WORKDIR /src
RUN npm install -g pnpm@11.9.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/studio/package.json apps/studio/package.json
COPY packages/otel/package.json packages/otel/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/catalog/package.json packages/catalog/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS built
COPY . .

FROM built AS api
RUN node scripts/bundle-api.mjs
ENV KEEL_BIND=0.0.0.0
CMD ["node", "apps/api/dist/server.js"]

FROM built AS web
RUN pnpm --filter @keel/web build
CMD ["node", "apps/web/serve.mjs"]

FROM deps AS studio-browsers
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pnpm --filter @keel/studio exec playwright install --with-deps chromium

FROM studio-browsers AS studio
COPY . .
RUN pnpm --filter @keel/studio build && node scripts/bundle-studio.mjs
ENV KEEL_STUDIO_STATIC=/src/apps/studio/dist
ENV KEEL_BIND=0.0.0.0
CMD ["node", "apps/studio/build/server.js"]
