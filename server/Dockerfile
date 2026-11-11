# Sabaq speech server + website in one container (e.g. a free Hugging Face Docker Space, port 7860).
# Build from the repository root:  docker build -f server/Dockerfile -t sabaq .
FROM node:20-slim
WORKDIR /app
COPY server/package.json server/
RUN cd server && npm install --omit=dev --no-audit --no-fund
COPY index.html app.js engine.js quran-data.js asr-worker.js coi-sw.js ./
COPY server/asr-server.js server/
ENV PORT=7860 HF_CACHE=/tmp/sabaq-hf-cache
EXPOSE 7860
CMD ["node", "server/asr-server.js"]
