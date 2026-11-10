FROM node:26.7.0-slim

ENV NODE_ENV=production

WORKDIR /app

# Same pnpm as mise.toml and pnpm-lock.yaml.
RUN npm install -g pnpm@11.25.0

COPY package.json pnpm-lock.yaml ./
COPY scripts ./scripts
COPY vendor ./vendor
RUN pnpm install --frozen-lockfile --prod

# Narrowed by .dockerignore: the ladder, the driver, the testbed, the spike,
# and the fake legs do not ship. The CMD never runs them.
COPY src ./src

USER node

EXPOSE 25565

CMD ["node", "src/service/monoplayer.js", "--start"]
