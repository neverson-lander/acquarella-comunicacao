FROM node:24-bookworm-slim
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /app/whatsapp-qr-gateway
COPY whatsapp-qr-gateway/package.json whatsapp-qr-gateway/pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY --chown=node:node whatsapp-qr-gateway/ ./
COPY --chown=node:node vercel-app/lib/qr-protocol.mjs /app/vercel-app/lib/qr-protocol.mjs
RUN mkdir -p /app/whatsapp-qr-gateway/data && chown node:node /app/whatsapp-qr-gateway/data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100
EXPOSE 3100
VOLUME ["/app/whatsapp-qr-gateway/data"]
CMD ["node", "server.mjs"]
