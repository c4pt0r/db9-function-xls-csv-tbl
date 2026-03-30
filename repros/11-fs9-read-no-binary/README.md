# Repro #11 — `ctx.fs9` has no binary read API; forces base64 workaround

## Summary

`ctx.fs9.read()` returns a UTF-8 string, making it unusable for binary files (images,
xlsx, zip, etc.). The workaround `ctx.fs9.readBase64()` adds ~33% size overhead and
requires an extra encode/decode step. The root cause is that the WebSocket protocol
between function-service and fs9-server uses JSON messages, which cannot carry raw
binary data.

## Impact

Any function that needs to read a binary file must:

```javascript
// ❌ Broken — binary data corrupted by UTF-8 decode
const content = await ctx.fs9.read("/uploads/file.xlsx");
const buf = Buffer.from(content);  // wrong bytes

// ✅ Workaround — base64 roundtrip (33% overhead)
const b64 = await ctx.fs9.readBase64("/uploads/file.xlsx");
const buf = Buffer.from(b64, "base64");
```

## Root cause

The function-service ↔ fs9-server WebSocket protocol uses JSON frames:

```json
// request
{ "op": "read", "path": "/uploads/file.xlsx" }

// response (current)
{ "content": "<base64 string>", "encoding": "base64", "size": 18414 }
```

JSON cannot represent raw bytes, so the server encodes to base64. WebSocket natively
supports binary frames (`ArrayBuffer`) which would eliminate the overhead entirely.

## Proposed fix

Add `ctx.fs9.readBinary()` returning a `Buffer`, using WebSocket binary frames:

```javascript
// function-service sends binary WebSocket frame instead of JSON
// ctx.fs9.readBinary(path: string): Promise<Buffer>

const buf = await ctx.fs9.readBinary("/uploads/file.xlsx");
// no base64 involved — raw bytes, no overhead
```

Alternatively, have `ctx.fs9.read()` auto-detect and return a `Buffer` when the
content is not valid UTF-8.

## Workaround

Use `ctx.fs9.readBase64()` and decode manually:

```javascript
const b64 = await ctx.fs9.readBase64(path);
if (b64 === null) throw new Error("file not found");
const buf = Buffer.from(b64, "base64");
```

## Notes

- Base64 adds ~33% size overhead (an 18 KB xlsx becomes ~24 KB in transit)
- Extra CPU cost for encoding on fs9-server and decoding in the function runtime
- `ctx.fs9.write()` has the same issue — it accepts only a string, so writing binary
  output is not possible at all without another encoding layer
