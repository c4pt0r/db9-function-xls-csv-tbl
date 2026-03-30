# db9 Function: xlsx → CSV

A db9 serverless function that converts Excel (`.xlsx`) files to CSV, one CSV per worksheet.

- **Zero runtime dependencies** — pure Node.js built-ins (`zlib` only), 7.5 KB bundle
- **Multi-sheet support** — each worksheet becomes a separate CSV file
- **Direct fs9 access** — reads from `/uploads/`, writes to `/output/` via `ctx.fs9`

## Prerequisites

- [`db9` CLI](https://db9.ai) installed and authenticated
- A db9 database (example: `myapp`)
- Node.js + npm (for building)

## Build

```bash
npm install
npm run build
# → dist/index-fs9.js  (~7.5 KB)
```

## Deploy

```bash
cat dist/index-fs9.js | db9 functions create xlsx-csv \
  --database myapp \
  --fs9-scope /uploads:ro \
  --fs9-scope /output:rw
```

- `--fs9-scope /uploads:ro` — function can read from `/uploads/` (read-only)
- `--fs9-scope /output:rw` — function can write to `/output/` (read-write)

To redeploy after code changes:

```bash
npm run build
cat dist/index-fs9.js | db9 functions update xlsx-csv --database myapp
```

## Usage

### 1. Upload an xlsx file

```bash
db9 fs cp your_file.xlsx myapp:/uploads/your_file.xlsx
```

### 2. Convert

Convert a single file:

```bash
db9 functions invoke xlsx-csv --database myapp \
  --payload '{"name": "your_file.xlsx"}'
```

Convert all xlsx files in `/uploads/`:

```bash
db9 functions invoke xlsx-csv --database myapp \
  --payload '{"all": true}'
```

Example output:

```json
{
  "converted": [
    { "source": "your_file.xlsx", "sheet": "Sales",     "path": "/output/your_file_Sales.csv",     "rows": 6, "cols": 5 },
    { "source": "your_file.xlsx", "sheet": "Inventory", "path": "/output/your_file_Inventory.csv", "rows": 5, "cols": 4 }
  ],
  "errors": []
}
```

### 3. Download CSVs

```bash
db9 fs cp myapp:/output/your_file_Sales.csv ./your_file_Sales.csv
db9 fs cp myapp:/output/your_file_Inventory.csv ./your_file_Inventory.csv
```

List all output files:

```bash
db9 fs ls myapp:/output/
```

## Input payload

| Field  | Type    | Description |
|--------|---------|-------------|
| `name` | string  | Filename under `/uploads/` to convert (e.g. `"report.xlsx"`) |
| `all`  | boolean | Convert all `.xlsx` files found in `/uploads/` |

One of `name` or `all` is required.

## How it works

```
db9 fs cp file.xlsx myapp:/uploads/
          │
          ▼
   /uploads/file.xlsx   (db9 fs9 filesystem)
          │  ctx.fs9.readBase64()
          ▼
  xlsx-csv function
  ├── readZip()           parse ZIP central directory
  ├── parseSharedStrings() decode OOXML shared string table
  ├── parseWorksheet()    extract rows and cells per sheet
  └── toCsv()            format as RFC 4180 CSV
          │  ctx.fs9.write()
          ▼
   /output/file_Sheet.csv  (db9 fs9 filesystem)
          │
          ▼
db9 fs cp myapp:/output/file_Sheet.csv ./
```

> **Note on binary reads**: `ctx.fs9.read()` returns UTF-8 strings and cannot handle
> binary files. The function uses `ctx.fs9.readBase64()` instead, which encodes the
> file content as base64 (~33% overhead). A native binary read API (`readBinary()`)
> would be more efficient — see [issue #870](https://github.com/c4pt0r/db9-backend/issues/870).

## Source files

| File | Description |
|------|-------------|
| `src/index-fs9.ts` | Main function — pure fs9 I/O, no SQL |
| `src/index.ts` | Alternative — SQL-based I/O (BYTEA table workaround, pre-fs9 fix) |
| `repros/` | Reproduction scripts for 11 bugs found during development |
| `function_test_report.md` | Full test report with bug details |

## Development notes and bugs found

See [`function_test_report.md`](function_test_report.md) for a detailed account of 11 bugs
encountered during development, including root causes, workarounds, and links to filed issues.

Quick summary of resolved issues relevant to this function:

| Issue | Status |
|-------|--------|
| `ctx.fs9.write()` "missing content" ([#867](https://github.com/c4pt0r/db9-backend/issues/867)) | Fixed in PR #869 |
| `ctx.fs9.readBase64()` returning null ([#859](https://github.com/c4pt0r/db9-backend/pull/859)) | Fixed in PR #869 |
| `db9 functions update` missing ([repro](repros/06-no-functions-update/README.md)) | Fixed in PR #862 |
| `db9 fs cp /dev/stdin` intermittent failure ([repro](repros/10-fs-cp-stdin-unstable/README.md)) | Fixed in PR #862 |
