# db9 Function Platform — Bug Reproductions

Each subdirectory contains a self-contained reproduction for one bug found while
building the xlsx-to-csv function. Every `handler.js` is a valid db9 function
bundle (CommonJS `module.exports = { handler }`), and every `deploy.sh` shows the
exact commands to deploy and invoke the reproduction.

## Prerequisites

```bash
# Authenticated db9 CLI
db9 auth status

# Set your database alias once
export DB=<your-db-alias>   # e.g. myapp
```

## Issues

| # | Directory | Severity | Title |
|---|-----------|----------|-------|
| 1 | `01-fs9-write-missing-content` | **P0 / Critical** | `ctx.fs9.write()` always throws "missing content" |
| 2 | `02-fs9-read-binary-null` | **P0 / Critical** | `ctx.fs9.read()` returns `null` for binary files |
| 3 | `03-fs9-read-bytea-secdef` | **P0 / Critical** | `fs9_read_bytea` ignores `SECURITY DEFINER` context |
| 4 | `04-db-query-array-rows` | **P1 / Important** | `ctx.db.query()` returns array rows, not object rows |
| 5 | `05-fs9-list-path-inconsistency` | **P1 / Important** | `ctx.fs9.list()` returns absolute paths; read/write expect relative |
| 6 | `06-no-functions-update` | **P1 / Important** | No `db9 functions update` command — can't redeploy same name |
| 7 | `07-no-ctx-self` | **P2 / Minor** | No `ctx.self` metadata (function ID, run ID, etc.) |
| 8 | `08-bundle-size-413` | **P2 / Minor** | Bundle size limit undocumented; oversized bundle returns raw nginx 413 HTML |
| 9 | `09-db-query-docs` | **P2 / Minor** | `ctx.db.query` row format not documented |
| 10 | `10-fs-cp-stdin-unstable` | **P2 / Minor** | `db9 fs cp /dev/stdin` intermittently fails on macOS |
