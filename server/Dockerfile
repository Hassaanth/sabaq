# Sabaq speech server + website in one container (e.g. a free Hugging Face Docker Space, port 7860).
# Build from the repository root:  docker build -f server/Dockerfile -t sabaq .

# 1. The fast model, built from NVIDIA's own checkpoint (see server/build-ctc-model.py)
FROM python:3.12-slim AS model
WORKDIR /m
RUN pip install --no-cache-dir onnx onnxruntime numpy pyyaml
ADD https://huggingface.co/nvidia/stt_ar_fastconformer_hybrid_large_pc_v1.0/resolve/main/stt_ar_fastconformer_hybrid_large_pc_v1.0.nemo nvidia.nemo
ADD https://huggingface.co/LukeJacob2023/sherpa-onnx-stt_ar_fastconformer_hybrid_large_pc/resolve/main/encoder.onnx encoder.onnx
ADD https://huggingface.co/LukeJacob2023/sherpa-onnx-stt_ar_fastconformer_hybrid_large_pc/resolve/main/tokens.txt tokens.txt
COPY server/build-ctc-model.py .
RUN tar xf nvidia.nemo ./model_config.yaml ./model_weights.ckpt && python build-ctc-model.py && rm -f nvidia.nemo encoder.onnx model.onnx model_weights.ckpt

# 2. The server
FROM node:20-slim
WORKDIR /app
COPY server/package.json server/
RUN cd server && npm install --omit=dev --no-audit --no-fund
COPY index.html app.js engine.js quran-data.js asr-worker.js coi-sw.js ./
COPY server/asr-server.js server/ctc-score.js server/
COPY --from=model /m/model.int8.onnx /m/tokens.txt server/models/pc/
ENV PORT=7860 HF_CACHE=/tmp/sabaq-hf-cache
EXPOSE 7860
CMD ["node", "server/asr-server.js"]
