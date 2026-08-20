FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs ./
RUN mkdir -p /app/data && chmod 700 /app/data
ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0
EXPOSE 8787
CMD ["node", "server.mjs"]
