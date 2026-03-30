# Repro #6 — No `db9 functions update` command

## Summary

`db9 functions create` fails with `"Function name already exists for this database"` if
the name is already taken. There is no `db9 functions update` (or `--force` / `--upsert`
flag) to redeploy an existing function under the same name.

This forces developers to use a new name on every iteration (`my-func-v1`,
`my-func-v2`, ...), accumulating stale functions in the database.

## Steps to reproduce

```bash
DB=myapp  # replace with your database alias

# Step 1: create a function
cat << 'EOF' | db9 functions create my-func --database "$DB"
const handler = async (input, ctx) => ({ version: 1 });
module.exports = { handler };
EOF
# ✓ Function 'my-func' created (id: ..., version: 1)

# Step 2: update the code and try to redeploy under the same name
cat << 'EOF' | db9 functions create my-func --database "$DB"
const handler = async (input, ctx) => ({ version: 2 });
module.exports = { handler };
EOF
# ✗ error: Function name already exists for this database
```

## Expected behavior

One of:
- `db9 functions create my-func --force` overwrites (or creates a new version of) an existing function
- `db9 functions update my-func` as a dedicated update/redeploy command
- `db9 functions create` with duplicate name automatically creates version 2 (upsert semantics)

## Current workaround

Use a different name on each deploy (e.g. append `-v2`, `-v3`, etc.) and delete old
versions manually:

```bash
# Deploy as new version
cat handler.js | db9 functions create my-func-v2 --database "$DB"

# Manually clean up old versions
db9 functions delete my-func --database "$DB"
db9 functions delete my-func-v2 --database "$DB"
```
