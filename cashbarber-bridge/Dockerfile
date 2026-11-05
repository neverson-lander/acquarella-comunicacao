FROM mcr.microsoft.com/playwright:v1.64.0-noble
WORKDIR /app/cashbarber-bridge
COPY cashbarber-bridge/package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --chown=pwuser:pwuser cashbarber-bridge/ ./
COPY --chown=pwuser:pwuser vercel-app/lib/cashbarber-domain.mjs vercel-app/lib/qr-protocol.mjs vercel-app/lib/daily-actions-domain.mjs /app/vercel-app/lib/
COPY --chown=pwuser:pwuser vercel-app/public/contact-domain.mjs /app/vercel-app/public/
RUN mkdir -p data && chown pwuser:pwuser data
USER pwuser
ENV HOST=0.0.0.0 PORT=3200 CASHBARBER_DATA_DIR=/app/cashbarber-bridge/data
CMD ["node", "server.mjs"]
