FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# ✅ git + git-lfs（大文件建议开启LFS，否则推大文件会失败或非常慢）
RUN apk update && apk upgrade && \
    apk add --no-cache unzip zip wget curl git git-lfs screen && \
    git lfs install

ENV PORT=7860
EXPOSE 7860

# ✅ 使用同步入口
RUN chmod +x /app/entrypoint.sh
CMD ["/app/entrypoint.sh"]
