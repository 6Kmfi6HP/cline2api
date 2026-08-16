#!/usr/bin/env bash
set -euo pipefail

# 加载本地 .env（含部署鉴权凭据），再调用 wrangler
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

exec npx wrangler "$@"