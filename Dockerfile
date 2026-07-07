FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
COPY client/package.json client/package-lock.json ./client/
COPY server/package.json server/package-lock.json ./server/
RUN npm install --no-cache
COPY . .
RUN npm --prefix client run build
RUN npm --prefix server run build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/client/dist ./client/dist
COPY package.json ./
EXPOSE 3001
CMD ["node", "server/dist/index.js"]
