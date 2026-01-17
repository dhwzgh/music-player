#!/bin/sh
set -e

: "${HF_DATASET:?HF_DATASET is required, e.g. username/myapp-state}"

# 兼容 HF Docker secrets
if [ -z "${HF_TOKEN:-}" ] && [ -f /run/secrets/HF_TOKEN ]; then
  HF_TOKEN="$(cat /run/secrets/HF_TOKEN)"
  export HF_TOKEN
fi
: "${HF_TOKEN:?HF_TOKEN is required}"

SUBDIR="${HF_SUBDIR:-music}"
STATE_DIR="${STATE_DIR:-/app/state}"
REPO_DIR="${STATE_DIR}/repo"
SYNC_SECONDS="${SYNC_SECONDS:-60}"

mkdir -p "$STATE_DIR"

echo "[sync] Cloning dataset repo: $HF_DATASET ..."
if [ ! -d "$REPO_DIR/.git" ]; then
  git clone "https://user:${HF_TOKEN}@huggingface.co/datasets/${HF_DATASET}" "$REPO_DIR" >/dev/null 2>&1 || true
fi

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

mkdir -p "$SUBDIR"

# ✅ 关键：让 app 写入 dataset 工作区（绝对路径）
export MUSIC_DIR="${REPO_DIR}/${SUBDIR}"
mkdir -p "$MUSIC_DIR"

echo "[sync] MUSIC_DIR=$MUSIC_DIR"

# ✅ 新增：启动时先拉取一次最新数据（不等同步循环）
echo "[sync] Pull latest on startup..."
git pull --rebase origin main >/dev/null 2>&1 || true

# 确保音频走 LFS（如果还没设置）
if [ ! -f ".gitattributes" ] || ! grep -q "filter=lfs" ".gitattributes"; then
  git lfs track "*.mp3" "*.flac" "*.wav" "*.m4a" >/dev/null 2>&1 || true
  git add .gitattributes >/dev/null 2>&1 || true
  git commit -m "chore: enable git lfs for audio" >/dev/null 2>&1 || true
  git push origin main >/dev/null 2>&1 || true
fi

sync_loop() {
  while true; do
    git pull --rebase origin main >/dev/null 2>&1 || true

    if [ -n "$(git status --porcelain)" ]; then
      echo "[sync] Changes detected, pushing..."
      git add -A
      git commit -m "sync music $(date -u +"%Y-%m-%dT%H:%M:%SZ")" >/dev/null 2>&1 || true
      git push origin main >/dev/null 2>&1 || true
      echo "[sync] Pushed."
    fi

    sleep "$SYNC_SECONDS"
  done
}

sync_loop &

echo "[app] Starting node app..."
cd /app
exec npm start
