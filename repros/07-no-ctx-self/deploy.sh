#!/usr/bin/env bash
# Repro #7 — No ctx.self metadata
# Usage: DB=myapp bash deploy.sh

set -e
DB="${DB:?Set DB to your database alias, e.g. DB=myapp}"

FUNC_NAME="repro-07-ctx-self"
echo "==> Deploying $FUNC_NAME..."
cat handler.js | db9 functions create "$FUNC_NAME" --database "$DB" 2>&1 || true

echo ""
echo "==> Invoking..."
db9 functions invoke "$FUNC_NAME" --database "$DB" --payload '{}'

echo ""
echo "Expected: ctx.self.functionId and ctx.self.runId are populated"
echo "Actual:   all undefined; ctxTopLevelKeys shows available properties"
