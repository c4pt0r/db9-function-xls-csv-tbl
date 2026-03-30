#!/usr/bin/env bash
# Repro #4 — ctx.db.query() returns array rows, not object rows
# Usage: DB=myapp bash deploy.sh

set -e
DB="${DB:?Set DB to your database alias, e.g. DB=myapp}"

FUNC_NAME="repro-04-db-rows"
echo "==> Deploying $FUNC_NAME..."
cat handler.js | db9 functions create "$FUNC_NAME" --database "$DB" 2>&1 || true

echo ""
echo "==> Invoking..."
db9 functions invoke "$FUNC_NAME" --database "$DB" --payload '{}'

echo ""
echo "Expected: byName.name = 'Alice', rowType = 'object'"
echo "Actual:   byName.name = undefined (null in JSON), rowType = 'array'"
