# db9 Functions — Test Report: xlsx-to-csv Conversion

**日期**: 2026-03-30
**测试者**: Claude Sonnet 4.6
**数据库**: myapp (yni0bc8v0zq0)
**任务**: 实现一个 db9 function，将指定的 xlsx 文件转换成 CSV

> **重现代码**: 每个 bug 的完整重现脚本见 [`repros/`](repros/) 目录。

---

## 目标

实现一个部署在 db9 上的 serverless function，接受用户指定的 xlsx 文件，解析所有工作表，并将每个工作表输出为 CSV 格式。要求：
- 不依赖外部 npm 包（db9 函数限制）
- 使用 TypeScript 编写
- 可以处理多工作表的 xlsx 文件
- 完整端到端可运行

---

## 思考过程与解决方案

### 技术挑战 1：npm 包限制 → 用 esbuild 打包但 bundle 过大

**问题**：db9 函数不支持 npm 包，但解析 xlsx 需要 SheetJS 等库。
**尝试**：用 SheetJS（xlsx npm 包）打包成单文件 → 1.8MB，超过上传大小限制。

> 完整重现步骤见 [`repros/08-bundle-size-413/README.md`](repros/08-bundle-size-413/README.md)

**解决方案**：放弃 SheetJS，用 Node.js 内置 `zlib` 实现最小化 OOXML 解析器（最终 7.5KB）。

---

### 技术挑战 2：二进制文件读取 → `ctx.fs9.read()` 对二进制文件返回 null

**问题**：xlsx 是二进制 ZIP 文件。`ctx.fs9.read(path)` 对二进制文件返回 `null`，与"文件不存在"无法区分。

> 完整重现代码见 [`repros/02-fs9-read-binary-null/`](repros/02-fs9-read-binary-null/)

**解决方案**：PR #859 新增了 `ctx.fs9.readBase64(path)`，返回 base64 编码的文件内容，可处理任意二进制文件：

```javascript
const b64 = await ctx.fs9.readBase64("/uploads/file.xlsx");
const buf = Buffer.from(b64, "base64");
```

注：这是 base64 绕道方案，有约 33% 的体积开销。原生二进制 API 的提案见 [issue #870](https://github.com/c4pt0r/db9-backend/issues/870)。

---

### 技术挑战 3：`fs9_read_bytea` 需要 superuser，SECURITY DEFINER 无效

**问题**：`fs9_read_bytea` 需要 superuser 权限；db9 函数以 `authenticated` 角色运行；用 SECURITY DEFINER 包装后仍被拒绝。

> 完整重现代码见 [`repros/03-fs9-read-bytea-secdef/`](repros/03-fs9-read-bytea-secdef/)

**与当前方案的关系**：最终方案完全不使用 `fs9_read_bytea`，通过 `ctx.fs9.readBase64()` 直接读取文件，此问题不再适用。

---

### 技术挑战 4：`ctx.db.query` 行为数组而非对象

**问题**：`ctx.db.query()` 返回的行是**数组**（`row[0]`），不是对象（`row.name`），与所有主流 PostgreSQL 客户端行为相反，且文档未说明。

> 完整重现代码见 [`repros/04-db-query-array-rows/`](repros/04-db-query-array-rows/)

**正确用法**：
```javascript
// ❌ row.name → undefined
// ✅ row[0]   → 第一列值
const b64 = r.rows[0][0];
```

---

### 技术挑战 5：`ctx.fs9.list()` 返回绝对路径，读写 API 用相对路径

**问题**：`list()` 返回 `/functions/<uuid>/uploads/file.xlsx`，但 `read()` 期望 `/uploads/file.xlsx`。直接使用 `list()` 的路径导致路径被双重添加前缀而报错。

> 完整重现代码见 [`repros/05-fs9-list-path-inconsistency/`](repros/05-fs9-list-path-inconsistency/)

---

### 技术挑战 6：ZIP Data Descriptor 导致条目丢失

**问题**：xlsx ZIP 中某些条目的本地文件头 `compressedSize = 0`（使用了 Data Descriptor），导致基于本地文件头的解析器跳过这些条目（如 `xl/sharedStrings.xml`）。

**解决方案**：改用 ZIP 中心目录（Central Directory）解析，其中大小字段始终准确：

```typescript
// 找 EOCD → 读中心目录 → 用中心目录的 compressedSize 定位数据
// 详见 src/index.ts: readZip()
```

---

### 技术挑战 7：OOXML 自闭合标签未被正则匹配

**问题**：`<sheet name="Sales" r:id="rId1"/>` 是自闭合标签，初始正则只匹配 `<tag>...</tag>`，导致解析到 0 个工作表，函数"成功"但输出为空。

**解决方案**：`matchTags()` 同时匹配自闭合和非自闭合（见 `src/index-fs9.ts`）。

---

### 技术挑战 8：`ctx.fs9.write()` 总是抛出 "missing content"

**问题**：`ctx.fs9.write(path, content)` 对任意内容、任意路径都抛出 `"missing content"`，文件写入功能完全失效。

> 完整重现代码见 [`repros/01-fs9-write-missing-content/`](repros/01-fs9-write-missing-content/)

**根本原因**：function-service 的 WebSocket 消息字段名错误，发送的是 `data` 而服务端期望 `content`（见 issue #867）。

**解决方案**：PR #869 修复了字段名，`ctx.fs9.write(path, content)` 现在正常工作。

---

## 最终架构

```
db9 fs cp file.xlsx myapp:/uploads/
          │
          ▼
   /uploads/file.xlsx   (db9 fs9 filesystem)
          │  ctx.fs9.readBase64()
          ▼
xlsx-csv function  (src/index-fs9.ts, 7.5 KB bundle)
  readZip() → parseWorkbook() → parseWorksheet() → toCsv()
          │  ctx.fs9.write()
          ▼
   /output/file_Sheet.csv  (db9 fs9 filesystem)
          │
          ▼
db9 fs cp myapp:/output/file_Sheet.csv ./
```

```bash
# 部署
npm run build
cat dist/index.js | db9 functions create xlsx-csv \
  --database myapp \
  --fs9-scope /uploads:ro \
  --fs9-scope /output:rw

# 上传
db9 fs cp your_file.xlsx myapp:/uploads/your_file.xlsx

# 转换
db9 functions invoke xlsx-csv --database myapp \
  --payload '{"name": "your_file.xlsx"}'

# 下载
db9 fs cp myapp:/output/your_file_Sales.csv ./
```

---

## Bug 汇总

以下按优先级排序。每个 bug 的完整重现代码见 [`repros/`](repros/) 目录。

### P0 — 严重阻断（Critical）

---

#### Bug 1：`ctx.fs9.write()` 总是抛出 "missing content"

**重现**: [`repros/01-fs9-write-missing-content/`](repros/01-fs9-write-missing-content/)

`ctx.fs9.write(path, content)` 对任意路径和内容均抛出 `Error("missing content")`。
文件写入功能完全失效，函数无法将任何文件输出到 db9 文件系统。

**错误信息误导性极强**：
- `"missing content"` 无法区分是"内容为空"、"目录不存在"还是"权限拒绝"
- 实际上内容非空（如 `"hello"` 字符串）也会报此错

**期望行为**：`ctx.fs9.write(path, content)` 在函数的 fs9 作用域中创建或更新文件。

**修复**：PR #869 修复了 WebSocket 消息字段名（`data` → `content`），`ctx.fs9.write` 现在正常工作。

---

#### Bug 2：`ctx.fs9.read()` 对二进制文件返回 `null`

**重现**: [`repros/02-fs9-read-binary-null/`](repros/02-fs9-read-binary-null/)

`ctx.fs9.read(path)` 对二进制文件（xlsx、zip、png 等）静默返回 `null`，不抛出异常。
与"文件不存在"的行为完全相同，无法区分。

**期望行为**：提供 `ctx.fs9.readBinary(path): Promise<Uint8Array>` 或 `ctx.fs9.readBase64(path): Promise<string>` 用于读取二进制文件。

---

#### Bug 3：`fs9_read_bytea` 的 SECURITY DEFINER 包装不生效

**重现**: [`repros/03-fs9-read-bytea-secdef/`](repros/03-fs9-read-bytea-secdef/)

`fs9_read_bytea` 要求 superuser 权限，db9 函数以 `authenticated` 运行。
用 SECURITY DEFINER 包装（创建者为 superuser）应使调用者透明获得权限——这是 PostgreSQL 标准行为——但 `fs9_read_bytea` 仍然报 `"permission denied (superuser required)"`。

**根本原因猜测**：`fs9_read_bytea` C 扩展使用 `GetOuterUserId()`（原始调用者角色）而非 `GetUserId()`（当前安全上下文），违反了 PostgreSQL SECURITY DEFINER 语义。

**期望行为**：SECURITY DEFINER 函数（owner 为 superuser）调用 `fs9_read_bytea` 时，应以 owner 权限执行。

---

### P1 — 重要（Important）

---

#### Bug 4：`ctx.db.query()` 返回数组行而非对象行

**重现**: [`repros/04-db-query-array-rows/`](repros/04-db-query-array-rows/)

`r.rows[0]` 是 `[1, "Alice", 99.5]`（数组），不是 `{ id: 1, name: "Alice", score: 99.5 }`（对象）。
`r.rows[0].name` 返回 `undefined`，静默失败，无任何提示。

这与 `pg`、`psycopg2`、`mysql2`、Drizzle 等所有主流 PostgreSQL 客户端行为相反，且文档未说明。

**期望行为**：返回对象行；或提供 `result.rowObjects` 作为兼容选项；或至少在文档中显著标注。

---

#### Bug 5：`ctx.fs9.list()` 返回绝对路径，读写 API 期望相对路径

**重现**: [`repros/05-fs9-list-path-inconsistency/`](repros/05-fs9-list-path-inconsistency/)

`ctx.fs9.list('/uploads')` 返回 `{ path: "/functions/<uuid>/uploads/file.xlsx" }`（绝对路径），
但 `ctx.fs9.read("/functions/<uuid>/uploads/file.xlsx")` 会再次添加前缀，变成双重路径而报错。

**期望行为**：`list()` 返回相对路径（如 `/uploads/file.xlsx`），与 `read()`/`write()` 保持一致。

---

#### Bug 6：无 `db9 functions update` 命令

**重现**: [`repros/06-no-functions-update/README.md`](repros/06-no-functions-update/README.md)

`db9 functions create` 对已存在的函数名返回错误，没有更新/覆盖命令，导致每次迭代都必须用新名称。

**期望行为**：
```bash
db9 functions create my-func --force   # 覆盖
# 或
db9 functions update my-func           # 专用更新命令
```

---

### P2 — 改善体验（Minor）

---

#### Bug 7：函数内无 `ctx.self` 元数据

**重现**: [`repros/07-no-ctx-self/`](repros/07-no-ctx-self/)

函数无法在运行时得知自己的函数 ID、名称、运行 ID 等。
当前只能通过 `ctx.fs9.list("/")` 从路径中提取函数 ID（脆弱，且需要预先上传文件）。

**期望行为**：
```typescript
ctx.self = {
  functionId:   string,  // "abc123-..."
  functionName: string,  // "xlsx-csv"
  databaseId:   string,  // "yni0bc8v0zq0"
  runId:        string,  // 当前调用的唯一 ID
}
```

---

#### Bug 8：Bundle 大小限制未记录；超限返回原始 nginx 413 HTML

**重现**: [`repros/08-bundle-size-413/README.md`](repros/08-bundle-size-413/README.md)

超过大小限制时，API 返回 nginx 原始 HTML `<html><h1>413 Request Entity Too Large</h1></html>`，
CLI 直接透传给用户，无大小限制说明、无修复建议。

**期望行为**：文档注明限制；CLI 上传前检查大小；API 返回结构化 JSON 错误。

---

#### Bug 9：`ctx.db.query` 行格式未在文档中说明

**详细说明**: [`repros/09-db-query-docs/README.md`](repros/09-db-query-docs/README.md)

FUNCTIONS.md 中没有任何示例揭示行为数组的非标准行为，是开发者最容易踩的隐藏坑。

---

#### Bug 10：`db9 fs cp /dev/stdin` 在 macOS 上偶发连接错误

**详细说明**: [`repros/10-fs-cp-stdin-unstable/README.md`](repros/10-fs-cp-stdin-unstable/README.md)

```
cp: /functions/<id>/file.txt: connection error: IO error: Connection refused (os error 61)
```
成功率约 70–90%，非确定性，仅在通过 stdin 管道时出现。

---

#### Bug 11：`ctx.fs9` 无二进制读取 API，被迫使用 base64 绕道

**重现**: [`repros/11-fs9-read-no-binary/README.md`](repros/11-fs9-read-no-binary/README.md)
**Issue**: [c4pt0r/db9-backend#870](https://github.com/c4pt0r/db9-backend/issues/870)

`ctx.fs9.read()` 只返回 UTF-8 字符串，无法读取二进制文件。`ctx.fs9.readBase64()` 是目前唯一的替代方案，但带来约 33% 的体积膨胀和额外的编解码开销。

**根本原因**：function-service 与 fs9-server 之间的 WebSocket 协议使用 JSON 消息帧，JSON 无法原生携带二进制数据，因此服务端将文件内容转为 base64 字符串返回。WebSocket 原生支持 binary frame（`ArrayBuffer`），完全可以避免这一开销。

**期望行为**：提供 `ctx.fs9.readBinary(path): Promise<Buffer>`，通过 WebSocket binary frame 传输，无需 base64。

---

## 测试结果摘要

| 功能 | 状态 | 备注 |
|------|------|------|
| 函数部署（小 bundle ≤ ~100KB）| ✅ 正常 | |
| `ctx.fs9.list()` | ✅ 正常 | 返回绝对路径（Bug 5）|
| `ctx.fs9.read()` 文本文件 | ✅ 正常 | |
| `ctx.fs9.read()` 二进制文件 | ❌ 返回 null | 设计限制，见 Bug 11 |
| `ctx.fs9.readBase64()` 二进制文件 | ✅ 正常 | PR #869 修复；base64 开销见 Bug 11 |
| `ctx.fs9.write()` | ✅ 正常 | PR #869 修复（原 Bug 1）|
| `db9 functions update` | ✅ 正常 | PR #862 修复（原 Bug 6）|
| `db9 fs cp /dev/stdin` | ✅ 正常 | PR #862 修复（原 Bug 10）|
| xlsx → CSV 端到端 | ✅ **正常** | `src/index-fs9.ts`，staging 验证通过 |
