#!/usr/bin/env bash
# Repro #1 — ctx.fs9.write() always throws "missing content"
# Usage: DB=myapp bash deploy.sh

set -e
DB="${DB:?Set DB to your database alias, e.g. DB=myapp}"

echo "==> Deploying repro-01-fs9-write..."
FUNC_NAME="repro-01-fs9-write"
cat handler.js | db9 functions create "$FUNC_NAME" --database "$DB" 2>&1 || true

echo ""
echo "==> Uploading a dummy file to initialize the function's fs9 scope..."
FUNC_ID=$(db9 functions list --database "$DB" --json 2>/dev/null \
  | python3 -c "import sys,json; fns=json.load(sys.stdin); \
    match=[f for f in fns if f.get('name')=='$FUNC_NAME']; \
    print(match[0]['id'] if match else '')" 2>/dev/null || echo "")

if [ -n "$FUNC_ID" ]; then
  echo "init" | db9 fs cp /dev/stdin "$DB:/functions/$FUNC_ID/init.txt" 2>/dev/null || true
fi

echo ""
echo "==> Invoking..."
db9 functions invoke "$FUNC_NAME" --database "$DB" --payload '{}'

echo ""
echo "Expected: all fields are 'ok'"
echo "Actual:   all fields show 'ERROR: missing content'"
