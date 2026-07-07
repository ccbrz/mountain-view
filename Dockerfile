FROM node:20-slim AS client-builder
WORKDIR /app
COPY client/package.json client/package-lock.json ./
RUN npm install
COPY client/ .
RUN npm run build

FROM node:20-slim AS server-builder
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm install
COPY server/ .
RUN npm run build

FROM node:20-slim
WORKDIR /app
COPY --from=server-builder /app/dist ./dist
COPY --from=server-builder /app/node_modules ./node_modules
COPY --from=server-builder /app/package.json ./
COPY --from=client-builder /app/dist ./client/dist
EXPOSE 3001
CMD ["node", "dist/index.js"]
