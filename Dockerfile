FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN apk update && apk upgrade && \
    apk add --no-cache unzip zip wget curl git git-lfs screen && \
    git lfs install

ENV PORT=7860
EXPOSE 7860

RUN chmod +x /app/entrypoint.sh
CMD ["/app/entrypoint.sh"]
