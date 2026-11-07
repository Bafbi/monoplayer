FROM node:26.7.0-slim

ENV NODE_ENV=production

WORKDIR /app

# Same pnpm as mise.toml and pnpm-lock.yaml.
RUN npm install -g pnpm@11.25.0

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY src ./src

USER node

EXPOSE 25565

CMD ["node", "src/monoplayer.js", "--start"]
