#!/usr/bin/env bash
# Repro #5 — ctx.fs9.list() returns absolute paths; read/write expect relative
# Usage: DB=myapp bash deploy.sh

set -e
DB="${DB:?Set DB to your database alias, e.g. DB=myapp}"
XLSX="${XLSX:-../../test_data.xlsx}"

FUNC_NAME="repro-05-fs9-paths"
echo "==> Deploying $FUNC_NAME..."
cat handler.js | db9 functions create "$FUNC_NAME" --database "$DB" 2>&1 || true

FUNC_ID=$(db9 functions list --database "$DB" --json 2>/dev/null \
  | python3 -c "import sys,json; fns=json.load(sys.stdin); \
    match=[f for f in fns if f.get('name')=='$FUNC_NAME']; \
    print(match[0]['id'] if match else '')" 2>/dev/null || echo "")

if [ -z "$FUNC_ID" ]; then
  echo "ERROR: Could not determine function ID"
  exit 1
fi

echo "==> Uploading test file..."
db9 fs cp "$XLSX" "$DB:/functions/$FUNC_ID/uploads/test_data.xlsx"

echo ""
echo "==> Invoking..."
db9 functions invoke "$FUNC_NAME" --database "$DB" --payload '{}'

echo ""
echo "Expected: pathFromList = '/uploads/test_data.xlsx' (relative)"
echo "Actual:   pathFromList = '/functions/<uuid>/uploads/test_data.xlsx' (absolute)"
echo "          readWithListedPath fails with double-prefix error"
