# db9 Function: xlsx → CSV

A db9 serverless function that converts Excel (`.xlsx`) files to CSV.

- One CSV per worksheet
- Zero dependencies — uses only Node.js built-ins, 7.5 KB bundle
- Reads from `/uploads/`, writes to `/output/` via `ctx.fs9`

## Quickstart

```bash
# Build
npm install && npm run build

# Deploy
cat dist/index.js | db9 functions create xlsx-csv \
  --database myapp \
  --fs9-scope /uploads:ro \
  --fs9-scope /output:rw

# Upload a file
db9 fs cp report.xlsx myapp:/uploads/report.xlsx

# Convert
db9 functions invoke xlsx-csv --database myapp \
  --payload '{"name": "report.xlsx"}'

# Download results
db9 fs cp myapp:/output/report_Sheet1.csv ./
```

## Input

| Field  | Type    | Description |
|--------|---------|-------------|
| `name` | string  | Filename under `/uploads/` to convert |
| `all`  | boolean | Convert all `.xlsx` files in `/uploads/` |

## Output

```json
{
  "converted": [
    { "source": "report.xlsx", "sheet": "Sheet1", "path": "/output/report_Sheet1.csv", "rows": 6, "cols": 5 }
  ],
  "errors": []
}
```

If the file has only one sheet, the output is named `report.csv` (no sheet suffix).

## Update after code changes

```bash
npm run build
cat dist/index.js | db9 functions update xlsx-csv --database myapp
```

## How it works

```
db9 fs cp file.xlsx myapp:/uploads/
                │
                │ ctx.fs9.readBase64()
                ▼
        xlsx-csv function
        ├─ parse ZIP (central directory)
        ├─ parse OOXML (workbook, shared strings, worksheets)
        └─ format CSV (RFC 4180)
                │
                │ ctx.fs9.write()
                ▼
        /output/file_Sheet.csv
                │
                ▼
db9 fs cp myapp:/output/file_Sheet.csv ./
```

## Notes

- `ctx.fs9.read()` returns UTF-8 strings and cannot handle binary files. The function
  uses `ctx.fs9.readBase64()` as a workaround (~33% size overhead).
  A native `ctx.fs9.readBinary()` API is proposed in [issue #870](https://github.com/c4pt0r/db9-backend/issues/870).
- See [`function_test_report.md`](function_test_report.md) for bugs found during development.
