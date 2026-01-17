#!/bin/sh
set -e

# 必填：HF_DATASET=你的username/你的datasetRepo
: "${HF_DATASET:?HF_DATASET is required, e.g. username/myapp-state}"
# 必填：HF_TOKEN=有写权限的hf token（建议放HF Space Secrets里）
: "${HF_TOKEN:?HF_TOKEN is required}"

# dataset 内存放音乐的子目录（你也可以改名）
SUBDIR="${HF_SUBDIR:-music}"
# 容器内本地工作目录（放git仓库）
STATE_DIR="${STATE_DIR:-/app/state}"
REPO_DIR="${STATE_DIR}/repo"
MUSIC_DIR="${STATE_DIR}/${SUBDIR}"

# 同步间隔（秒）
SYNC_SECONDS="${SYNC_SECONDS:-60}"

mkdir -p "$STATE_DIR"

echo "[sync] Cloning dataset repo: $HF_DATASET ..."
# 用 token 克隆 dataset（不要 echo token）
# 注意：huggingface 的 dataset git 地址是 https://huggingface.co/datasets/<repo>
if [ ! -d "$REPO_DIR/.git" ]; then
  git clone "https://user:${HF_TOKEN}@huggingface.co/datasets/${HF_DATASET}" "$REPO_DIR" >/dev/null 2>&1 || true
fi

# 如果 clone 失败（比如 repo 为空还没初始化），就初始化一个
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "[sync] Repo not found or empty. Initializing new repo structure..."
  mkdir -p "$REPO_DIR"
  cd "$REPO_DIR"
  git init
  git remote add origin "https://user:${HF_TOKEN}@huggingface.co/datasets/${HF_DATASET}"
  git checkout -b main
fi

cd "$REPO_DIR"
git config user.email "${GIT_EMAIL:-bot@users.noreply.huggingface.co}"
git config user.name  "${GIT_NAME:-hf-sync-bot}"

# 确保子目录存在
mkdir -p "$SUBDIR"

# 把 repo 的音乐目录映射为应用的 MUSIC_DIR
mkdir -p "$MUSIC_DIR"

# ✅ 关键：让你的 app 直接把歌写到 dataset 仓库里
# 你的 app.js 支持 MUSIC_DIR 环境变量，我们这里设置它指向 repo 子目录
export MUSIC_DIR="$SUBDIR"

# 后台同步循环：有变化才 commit+push
sync_loop() {
  while true; do
    # 拉一下远端（避免冲突）
    git pull --rebase origin main >/dev/null 2>&1 || true

    if [ -n "$(git status --porcelain)" ]; then
      echo "[sync] Changes detected, pushing..."
      git add -A
      git commit -m "sync music $(date -u +"%Y-%m-%dT%H:%M:%SZ")" >/dev/null 2>&1 || true
      # 推送
      git push origin main >/dev/null 2>&1 || true
      echo "[sync] Pushed."
    fi

    sleep "$SYNC_SECONDS"
  done
}

sync_loop &

echo "[app] Starting node app..."
exec npm start
