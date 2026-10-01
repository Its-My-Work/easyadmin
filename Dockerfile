FROM node:22-alpine
ENV NODE_ENV=production EASYADMIN_DATA=/data PORT=3100
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
RUN apk add --no-cache openssh-client && mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3100/api/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
