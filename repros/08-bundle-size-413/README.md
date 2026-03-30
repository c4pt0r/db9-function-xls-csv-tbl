# Repro #8 — Bundle size limit undocumented; oversized upload returns nginx 413

## Summary

When a function bundle exceeds the (undocumented) size limit, the API returns a raw
nginx `413 Request Entity Too Large` HTML page instead of a structured JSON error.
The CLI surfaces this HTML directly to the user without any helpful guidance.

## Steps to reproduce

```bash
DB=myapp   # replace with your database alias

# Step 1: install a large npm package (SheetJS ~1.8 MB when bundled)
npm install xlsx

# Step 2: create a function that imports it
cat << 'EOF' > large_bundle_entry.js
const XLSX = require('xlsx');
const handler = async (input, ctx) => {
  const wb = XLSX.utils.book_new();
  return { ok: true };
};
module.exports = { handler };
EOF

# Step 3: bundle with esbuild
npx esbuild large_bundle_entry.js \
  --bundle --platform=node --target=node18 --format=cjs \
  --outfile=large_bundle.js
# → large_bundle.js  ~1.8 MB

ls -lh large_bundle.js

# Step 4: try to deploy — observe the raw 413 error
cat large_bundle.js | db9 functions create test-large-bundle --database "$DB"
# error: <html><h1>413 Request Entity Too Large</h1></html>
# (no indication of what the size limit is or how to fix it)
```

## Expected behavior

1. **Documentation**: The max bundle size should be documented (e.g. "256 KB").
2. **CLI validation**: The CLI should check size before uploading and emit:
   ```
   Error: Function bundle too large (1.8 MB). Maximum allowed size is 256 KB.
   Tip: Avoid large npm packages. Use --minify with esbuild to reduce size.
   ```
3. **API error**: If the bundle reaches the API, return a structured JSON error:
   ```json
   { "error": "bundle_too_large", "message": "Bundle exceeds 256 KB limit", "size": 1843200 }
   ```
   instead of a raw nginx HTML page.

## Notes

- The function in this repo (`src/index.ts`) works around this by implementing a
  zero-dependency OOXML/ZIP parser using only Node.js built-ins, resulting in a
  7.5 KB bundle.
- `esbuild --minify` reduces the SheetJS bundle to ~1.2 MB — still too large.
