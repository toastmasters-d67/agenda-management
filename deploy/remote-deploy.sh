#!/usr/bin/env bash
#
# 在 vm-postgen-prod 上執行的部署步驟（由 .github/workflows/ci-cd.yml 透過 SSH 呼叫）。
#
# 輸入：
#   環境變數 IMAGE_TAG       要部署的 commit SHA
#   環境變數 REGISTRY_USER   GHCR 帳號（github.actor）
#   stdin                    GHCR token（該次 workflow 的 GITHUB_TOKEN）
#
# 前提：/srv/club-management/.env 已由 workflow 上傳（來源是 PROD_ENV_FILE secret）。
#
# 手動回滾：
#   cd /srv/club-management && cat .deploy-history   # 找上一個 SHA
#   sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=<舊SHA>/" .env && docker compose up -d --no-build api web
#   ⚠ 新版若已跑過 migration，舊版程式可能不認得新 schema——
#     那時要先 alembic downgrade，或用 backups/ 裡部署前的 dump 還原。

set -euo pipefail

cd /srv/club-management

: "${IMAGE_TAG:?缺 IMAGE_TAG}"
: "${REGISTRY_USER:?缺 REGISTRY_USER}"

# ① 登入 GHCR 並拉 image。token 只活在這次部署裡，拉完就登出。
read -r REGISTRY_TOKEN
printf '%s\n' "$REGISTRY_TOKEN" | docker login ghcr.io -u "$REGISTRY_USER" --password-stdin >/dev/null
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT

# ② 把版本寫進 .env，之後有人手動 `docker compose up -d` 也會是同一版。
PREVIOUS_TAG="$(sed -n 's/^IMAGE_TAG=//p' .deploy-current 2>/dev/null || true)"
if grep -q '^IMAGE_TAG=' .env; then
  sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=${IMAGE_TAG}/" .env
else
  printf 'IMAGE_TAG=%s\n' "$IMAGE_TAG" >> .env
fi
docker compose pull api web

# ③ 資料庫起來後先備份，再跑 migration。第一次部署時資料庫是空的，備份也無妨。
docker compose up -d --wait db
echo "→ 部署前備份"
./backup.sh pre-deploy

echo "→ alembic upgrade head"
docker compose run --rm --no-deps api alembic upgrade head

# ④ 換版。--no-build：VM 上絕不 build，跑的必須是 CI 測過的那一個 image。
docker compose up -d --no-build --remove-orphans api web
printf 'IMAGE_TAG=%s\n' "$IMAGE_TAG" > .deploy-current
printf '%s\t%s\t(上一版 %s)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$IMAGE_TAG" "${PREVIOUS_TAG:-無}" >> .deploy-history

# ⑤ 健康檢查：前端登入頁與後端都要回應。
echo "→ 等待服務就緒"
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null http://127.0.0.1:3000/club-management/login \
     && curl -fsS -o /dev/null http://127.0.0.1:8001/.well-known/oauth-protected-resource; then
    echo "✓ 部署完成：${IMAGE_TAG}"
    docker image prune -f --filter "until=168h" >/dev/null || true
    exit 0
  fi
  sleep 3
done

echo "✗ 90 秒內服務沒有就緒。最近的日誌：" >&2
docker compose logs --tail 80 api web >&2
echo "上一版是 ${PREVIOUS_TAG:-無}；回滾方式見這支腳本開頭的註解。" >&2
exit 1
