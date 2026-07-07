FROM node:20-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates && rm -rf /var/lib/apt/lists/* && npm install -g npm@11
WORKDIR /app

COPY client/package.json client/package-lock.json ./client/
COPY server/package.json server/package-lock.json ./server/
COPY package.json ./

RUN cd client && npm install && cd ..
RUN cd server && npm install && cd ..
COPY . .
RUN cd client && npm run build && cd ..
RUN cd server && npm run build && cd ..

FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/node_modules ./node_modules
COPY --from=build /app/server/package.json ./
COPY --from=build /app/client/dist ./client/dist
EXPOSE 3001
CMD ["node", "dist/index.js"]
