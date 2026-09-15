# marked is the only dependency: hand-rolling a markdown parser mangles
# nested lists, pipe tables and fenced blocks inside list items.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
USER node
CMD ["node", "server.js"]
