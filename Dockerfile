FROM node:20-alpine

WORKDIR /app

# 先拷依赖文件，利用缓存加速构建
COPY package*.json ./
RUN npm install

# 再拷代码
COPY . .

# git + git-lfs（大文件建议走LFS）
RUN apk update && apk upgrade && \
    apk add --no-cache unzip zip wget curl git git-lfs screen && \
    git lfs install

# Hugging Face Docker Space 常用 PORT（默认很多是7860）
ENV PORT=7860
EXPOSE 7860

# 使用同步入口
RUN chmod +x /app/entrypoint.sh
CMD ["/app/entrypoint.sh"]
