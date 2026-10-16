FROM node:24-bookworm-slim
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /app/vercel-app
COPY vercel-app/package.json vercel-app/pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY --chown=node:node vercel-app/ ./
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DEPLOYMENT_MODE=standalone
EXPOSE 3000
CMD ["node", "scripts/standalone-server.mjs"]
