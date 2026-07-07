FROM node:20-alpine AS client-builder
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/ .
COPY --from=client-builder /app/client/dist ./client/dist
EXPOSE 3001
CMD ["npm", "start"]
