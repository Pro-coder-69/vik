# Dependency-free server: nothing to install, just copy it in.
FROM node:22-alpine
WORKDIR /app
COPY server.js ./
USER node
CMD ["node", "server.js"]
