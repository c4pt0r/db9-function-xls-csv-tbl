#!/usr/bin/env bash
# Repro #3 — fs9_read_bytea() ignores SECURITY DEFINER context
# Usage: DB=myapp bash deploy.sh

set -e
DB="${DB:?Set DB to your database alias, e.g. DB=myapp}"
XLSX="${XLSX:-../../test_data.xlsx}"

echo "==> Step 1: Running setup.sql (creates SECURITY DEFINER wrapper)..."
db9 db sql "$DB" < setup.sql

echo ""
echo "==> Step 2: Deploying repro-03-fs9-secdef..."
FUNC_NAME="repro-03-fs9-secdef"
cat handler.js | db9 functions create "$FUNC_NAME" --database "$DB" 2>&1 || true

FUNC_ID=$(db9 functions list --database "$DB" --json 2>/dev/null \
  | python3 -c "import sys,json; fns=json.load(sys.stdin); \
    match=[f for f in fns if f.get('name')=='$FUNC_NAME']; \
    print(match[0]['id'] if match else '')" 2>/dev/null || echo "")

if [ -z "$FUNC_ID" ]; then
  echo "ERROR: Could not determine function ID"
  exit 1
fi

echo ""
echo "==> Step 3: Uploading binary test file..."
db9 fs cp "$XLSX" "$DB:/functions/$FUNC_ID/uploads/test_data.xlsx"

echo ""
echo "==> Invoking..."
db9 functions invoke "$FUNC_NAME" --database "$DB" --payload '{}'

echo ""
echo "Expected: secdef_call: 'ok, b64_length=...'"
echo "Actual:   secdef_call: 'ERROR: fs9: permission denied (superuser required)'"
