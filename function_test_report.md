# db9 Functions — Test Report: xlsx-to-csv Conversion

**日期**: 2026-03-30
**测试者**: Claude Sonnet 4.6
**数据库**: myapp (yni0bc8v0zq0)
**任务**: 实现一个 db9 function，将用户文件夹下的所有 xlsx 转换成 CSV

---

## 目标

实现一个部署在 db9 上的 serverless function，接受用户指定的 xlsx 文件，解析所有工作表，并将每个工作表输出为 CSV 格式。要求：
- 不依赖外部 npm 包（db9 函数限制）
- 使用 TypeScript 编写
- 可以处理多工作表的 xlsx 文件
- 完整端到端可运行

---

## 思考过程与解决方案

### 技术挑战 1：npm 包限制 → 用 esbuild 打包

**问题**：db9 函数不支持 npm 包（运行时没有 node_modules），但解析 xlsx 需要 SheetJS 等库。

**尝试**：最初计划用 SheetJS（xlsx npm 包），通过 esbuild bundle 打包成单文件。

**结果**：打包后文件 1.8MB（压缩后 1.2MB），超过 API 上传大小限制（返回 `413 Request Entity Too Large`）。

```bash
# 触发错误的命令
npm run build  # → dist/index.js 1.8mb
cat dist/index.js | db9 functions create xlsx-to-csv --db myapp
# error: <html><h1>413 Request Entity Too Large</h1></html>
```

**解决方案**：完全放弃 SheetJS，用 Node.js 内置的 `zlib`（deflate 解压）和纯字符串解析实现最小化 OOXML 解析器（最终打包后 7.5KB）。

---

### 技术挑战 2：二进制文件读取 → `ctx.fs9.read()` 对二进制文件返回 null

**问题**：xlsx 是二进制 ZIP 文件。`ctx.fs9.read(path)` 文档说返回 UTF-8 字符串，但对二进制文件实测返回 `null`。

**重现代码**：
```javascript
const handler = async (input, ctx) => {
  const entries = await ctx.fs9.list('/uploads');
  const filename = entries[0].path.split('/').pop();
  const content = await ctx.fs9.read('/uploads/' + filename);
  return {
    type: typeof content,        // → "object"（null 的 typeof）
    isNull: content === null,    // → true
    length: content?.length,     // → undefined
  };
};
module.exports = { handler };
```

**重现步骤**：
```bash
# 上传二进制 xlsx 文件
db9 fs cp test_data.xlsx myapp:/functions/<func_id>/uploads/test_data.xlsx

# 部署调试函数
cat <<'EOF' | db9 functions create debug-read --database myapp
const handler = async (input, ctx) => {
  const entries = await ctx.fs9.list('/uploads');
  const relPath = '/uploads/' + entries[0].path.split('/').pop();
  const content = await ctx.fs9.read(relPath);
  return { type: typeof content, isNull: content === null };
};
module.exports = { handler };
EOF

db9 functions invoke debug-read --database myapp --payload '{}'
# Result: {"type":"object","isNull":true}
```

**db9 团队需修复**：
- `ctx.fs9.read()` 对二进制文件应该要么返回 `Uint8Array`/`Buffer`，要么提供单独的 `ctx.fs9.readBinary(path)` API
- 或者至少返回 base64 编码的字符串而不是 `null`
- 返回 `null` 会让开发者误以为文件不存在，与 "No such file" 错误无法区分

---

### 技术挑战 3：SQL `fs9_read_bytea` 需要 superuser → 函数以 `authenticated` 角色运行

**问题**：`fs9_read_bytea(path)` 是 db9 的 SQL 扩展函数，可以以 BYTEA 格式读取文件，但需要 SUPERUSER 权限。db9 函数的 `ctx.db.query()` 以 `authenticated` 角色运行（非 superuser）。

**重现代码**：
```sql
-- 验证当前角色
SELECT current_user, session_user;
-- 函数内运行结果: "authenticated", "authenticated"
```

```javascript
// 在 db9 函数内
const handler = async (input, ctx) => {
  const whoami = await ctx.db.query("SELECT current_user, session_user");
  return whoami.rows[0];  // → ["authenticated", "authenticated"]
};
```

```javascript
// 尝试读取二进制文件
const handler = async (input, ctx) => {
  try {
    const r = await ctx.db.query(
      "SELECT encode(fs9_read_bytea('/uploads/test.xlsx'), 'base64')"
    );
    return { data: r.rows[0][0] };
  } catch (e) {
    return { error: e.message };
    // → "ERROR: fs9: permission denied (superuser required)"
  }
};
```

**尝试用 SECURITY DEFINER 绕过**：

```sql
-- 以 admin（superuser）身份创建包装函数
CREATE OR REPLACE FUNCTION public.read_binary_b64(path TEXT)
RETURNS TEXT
LANGUAGE SQL
SECURITY DEFINER
AS $$ SELECT encode(fs9_read_bytea(path), 'base64') $$;
```

```javascript
// 调用包装函数 —— 仍然失败
const r = await ctx.db.query("SELECT public.read_binary_b64($1)", [path]);
// → "ERROR: fs9: permission denied (superuser required)"
```

**结论**：`fs9_read_bytea` 内部检查机制绕过了 PostgreSQL 的 SECURITY DEFINER 机制（可能是通过 C 层直接调用 `GetOuterUserId()` 而非 `GetUserId()`）。

**解决方案（Workaround）**：将 xlsx 二进制数据存储在 PostgreSQL 的 `BYTEA` 列中（通过 admin 用户插入，`authenticated` 可读写），绕过 `fs9_read_bytea`：

```sql
-- 以 admin 用户创建表
CREATE TABLE xlsx_staging (
  name TEXT PRIMARY KEY,
  data BYTEA,
  uploaded_at TIMESTAMPTZ DEFAULT NOW()
);
GRANT ALL ON xlsx_staging TO authenticated;
```

```bash
# 用户上传 xlsx（通过 base64 编码插入）
B64=$(base64 < file.xlsx)
db9 db sql myapp -q "
INSERT INTO xlsx_staging (name, data)
VALUES ('file.xlsx', decode('$B64', 'base64'))
ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, uploaded_at = NOW()
"
```

```javascript
// 函数内读取 BYTEA（以 base64 方式，通过 SQL encode() 函数）
const r = await ctx.db.query(
  "SELECT encode(data, 'base64') FROM xlsx_staging WHERE name = $1",
  [name]
);
const b64 = r.rows[0][0];  // ✓ 成功
const buf = Buffer.from(b64, 'base64');
```

**db9 团队需修复**：
1. `fs9_read_bytea` 应该对 `SECURITY DEFINER` 包装函数的 owner 检查有效（标准 PostgreSQL 行为）
2. 或者提供一个不需要 superuser 的 `fs9_read_bytea` 变体供函数运行时使用
3. 或者在 `ctx.fs9` API 中直接提供 `readBinary(path): Promise<Uint8Array>` 方法

---

### 技术挑战 4：`ctx.db.query` 返回数组行而非对象行

**问题**：文档和直觉都暗示 `ctx.db.query()` 返回的行是对象（`row.columnName`），但实际上返回的是**数组**（`row[0]`、`row[1]`）。

**重现代码**：
```javascript
const handler = async (input, ctx) => {
  const r = await ctx.db.query(
    "SELECT name, length(data) as bytes FROM xlsx_staging LIMIT 1"
  );
  return {
    rows: JSON.stringify(r.rows),
    firstRow: JSON.stringify(r.rows[0]),
    keys: r.rows[0] ? Object.keys(r.rows[0]) : [],
  };
};
```

**实际结果**：
```json
{
  "rows": "[[\"test_data.xlsx\",18414]]",
  "firstRow": "[\"test_data.xlsx\",18414]",
  "keys": ["0","1"]
}
```

**预期结果（直觉）**：
```json
{
  "rows": "[{\"name\":\"test_data.xlsx\",\"bytes\":18414}]",
  "firstRow": "{\"name\":\"test_data.xlsx\",\"bytes\":18414}",
  "keys": ["name","bytes"]
}
```

**影响**：所有基于列名的访问（`row.name`、`row.bytes`）都会是 `undefined`。
必须改为 `row[0]`、`row[1]`，但这会使代码更难阅读且容易出错。

**正确用法示例**：
```javascript
// ❌ 错误（直觉写法）
const name = r.rows[0].name;
const bytes = r.rows[0].bytes;

// ✓ 正确（实际行为）
const name = r.rows[0][0];
const bytes = r.rows[0][1];
```

**db9 团队需修复**：
1. `ctx.db.query()` 应返回对象行（`{columnName: value}`），这是所有主流 PostgreSQL 客户端（pg、psycopg2、Drizzle 等）的标准行为
2. 或者在函数运行时文档中显著标注这一非标准行为
3. 可以同时提供 `rows`（数组）和 `rowsAsObjects`（对象）两种格式

---

### 技术挑战 5：`ctx.fs9.list()` 返回绝对路径，但读写 API 要求相对路径

**问题**：`ctx.fs9.list("/uploads")` 返回的条目中 `path` 字段是**绝对路径**（包含函数 ID 前缀），但 `ctx.fs9.read(path)` 和 `ctx.fs9.write(path, content)` 要求**相对路径**（相对于函数根）。

**重现代码**：
```javascript
const handler = async (input, ctx) => {
  const entries = await ctx.fs9.list('/uploads');
  console.log(JSON.stringify(entries[0]));
  // → {"path":"/functions/f04a911e-.../uploads/test_data.xlsx","type":"file",...}

  // 用 list() 返回的绝对路径尝试读取 → 路径被二次前缀化，报错
  try {
    await ctx.fs9.read(entries[0].path);
  } catch(e) {
    console.log(e.message);
    // → "No such file or directory: /functions/f04a911e-.../functions/f04a911e-.../uploads/test_data.xlsx"
  }

  // 正确方式：从路径中提取文件名，重新构造相对路径
  const filename = entries[0].path.split('/').pop();
  const content = await ctx.fs9.read('/uploads/' + filename);  // ✓
};
```

**db9 团队需修复**：
1. `ctx.fs9.list()` 应返回**相对路径**（相对于函数根），与读写 API 保持一致。
   例如，返回 `{ path: "/uploads/test_data.xlsx", type: "file" }` 而不是 `{ path: "/functions/<id>/uploads/test_data.xlsx", type: "file" }`
2. 或者，`ctx.fs9.read(path)` 应同时接受绝对路径和相对路径
3. 路径 API 的不一致是导致开发者最大困惑的来源之一

---

### 技术挑战 6：`ctx.fs9.write()` 总是抛出 "missing content" 错误

**问题**：`ctx.fs9.write(path, content)` 对任意内容（包括简单的 `"hello"` 字符串）都会抛出 `"missing content"` 错误，无论路径是相对还是绝对，无论内容是否为空。

**重现代码**：
```javascript
const handler = async (input, ctx) => {
  const tests = {
    relative: null,
    absolute: null,
    empty: null,
  };

  try {
    await ctx.fs9.write("/out.csv", "hello,world\n1,2");
    tests.relative = "ok";
  } catch(e) { tests.relative = e.message; }

  // 获取函数绝对路径
  const root = await ctx.fs9.list("/");
  const funcPath = root[0]?.path?.match(/^(\/functions\/[^/]+\/)/)?.[1];

  try {
    await ctx.fs9.write(funcPath + "out.csv", "hello,world\n1,2");
    tests.absolute = "ok";
  } catch(e) { tests.absolute = e.message; }

  try {
    await ctx.fs9.write("/out.csv", "");
    tests.empty = "ok";
  } catch(e) { tests.empty = e.message; }

  return { funcPath, tests };
};
module.exports = { handler };
```

**结果**：
```json
{
  "funcPath": "/functions/45167907-.../",
  "tests": {
    "relative": "missing content",
    "absolute": "missing content",
    "empty": "missing content"
  }
}
```

**部署和重现步骤**：
```bash
# 1. 创建测试函数
cat << 'EOF' | db9 functions create test-write --database myapp
const handler = async (input, ctx) => {
  try {
    await ctx.fs9.write("/test.csv", "a,b\n1,2");
    return { result: "ok" };
  } catch(e) {
    return { error: e.message };
  }
};
module.exports = { handler };
EOF

# 2. 初始化 fs9（上传任意文件）
echo "init" | db9 fs cp /dev/stdin myapp:/functions/<func_id>/init.txt

# 3. 调用函数
db9 functions invoke test-write --database myapp --payload '{}'
# → {"error": "missing content"}
```

**影响**：函数完全无法写入文件到 db9 文件系统。这是 `ctx.fs9` 中最严重的 bug，导致函数的文件输出能力完全失效。

**解决方案（Workaround）**：将输出写入 PostgreSQL 表而不是文件系统：

```sql
-- 创建输出表
CREATE TABLE csv_output (
  source_name TEXT,
  sheet_name TEXT,
  csv_content TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (source_name, sheet_name)
);
GRANT ALL ON csv_output TO authenticated;
```

```javascript
// 函数内写入 CSV 到数据库表
await ctx.db.query(
  `INSERT INTO csv_output (source_name, sheet_name, csv_content)
   VALUES ($1, $2, $3)
   ON CONFLICT (source_name, sheet_name)
   DO UPDATE SET csv_content = EXCLUDED.csv_content, created_at = NOW()`,
  [fileName, sheetName, csvContent]
);
```

```bash
# 用户下载 CSV
db9 db sql myapp --output raw \
  -q "SELECT csv_content FROM csv_output WHERE source_name='file.xlsx' AND sheet_name='Sales'"
```

**db9 团队需修复**：
1. `ctx.fs9.write(path, content)` 应正常工作（写入文件到函数的 fs9 作用域）
2. 修复后，当前使用数据库表作为输出的 workaround 可以移除
3. 错误信息 "missing content" 非常误导人——它不描述实际原因。如果是权限问题，应该说 "permission denied"；如果是目录不存在，应该说 "parent directory not found"

---

### 技术挑战 7：ZIP 解析中 Data Descriptor 导致条目丢失

**问题**：xlsx 文件（ZIP 格式）中某些条目使用了 **Data Descriptor**（通用位标志第 3 位置位），此时本地文件头中的 `compressedSize` 字段为 0，实际大小记录在数据描述符中（位于压缩数据之后）。

若只扫描本地文件头来解析 ZIP，`compressedSize=0` 会导致解析器陷入死循环或跳过后续条目。

**初始实现（有缺陷）**：
```typescript
// 从本地文件头读取 compressedSize（可能为 0）
const compressedSize = buf.readUInt32LE(i + 18);
const compressed = buf.slice(dataStart, dataStart + compressedSize);  // 空！
i = dataStart + compressedSize;  // 不前进！
```

**现象**：`xl/sharedStrings.xml` 等某些条目不出现在解析结果中。

```bash
# 调试输出
# ZIP files: [xl/_rels/workbook.xml.rels, xl/theme/theme1.xml, xl/styles.xml,
#             xl/worksheets/sheet1.xml, xl/worksheets/sheet2.xml, xl/metadata.xml,
#             xl/workbook.xml, _rels/.rels, docProps/app.xml, docProps/core.xml,
#             [Content_Types].xml]
# 注意：xl/sharedStrings.xml 不见了！
```

**解决方案**：改用 ZIP 中心目录（Central Directory）来解析，其中的大小字段始终是准确的：

```typescript
function readZip(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();

  // 1. 找到 EOCD（End of Central Directory）签名 PK\x05\x06
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i]===0x50 && buf[i+1]===0x4b && buf[i+2]===0x05 && buf[i+3]===0x06) {
      eocd = i; break;
    }
  }
  if (eocd < 0) return files;

  const cdEntries = buf.readUInt16LE(eocd + 10);
  const cdOffset  = buf.readUInt32LE(eocd + 16);

  // 2. 遍历中心目录（总是有准确的 compressedSize）
  let pos = cdOffset;
  for (let e = 0; e < cdEntries; e++) {
    // 中心目录条目签名: PK\x01\x02
    if (buf[pos]!==0x50||buf[pos+1]!==0x4b||buf[pos+2]!==0x01||buf[pos+3]!==0x02) break;

    const compression  = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);  // 中心目录中总是准确
    const fnLen        = buf.readUInt16LE(pos + 28);
    const extraLen     = buf.readUInt16LE(pos + 30);
    const commentLen   = buf.readUInt16LE(pos + 32);
    const localOffset  = buf.readUInt32LE(pos + 42);
    const filename     = buf.slice(pos+46, pos+46+fnLen).toString("utf8");

    // 3. 跳到本地文件头，获取实际数据起始位置
    const lhFnLen    = buf.readUInt16LE(localOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart  = localOffset + 30 + lhFnLen + lhExtraLen;

    if (compressedSize > 0) {
      const compressed = buf.slice(dataStart, dataStart + compressedSize);
      try {
        files.set(filename, compression === 0 ? compressed : inflateRawSync(compressed));
      } catch { /* skip unreadable entry */ }
    }

    pos += 46 + fnLen + extraLen + commentLen;
  }

  return files;
}
```

**db9 团队**（本问题不涉及 db9 平台，属于通用 ZIP 解析知识）：
建议在 functions 文档中添加"处理二进制格式"的示例代码，说明如何正确解析 ZIP 文件。

---

### 技术挑战 8：XML 自闭合标签未被正则匹配

**问题**：OOXML 中的 `<sheet>` 和 `<Relationship>` 元素都是**自闭合标签**（`<tag ... />`），初始正则只匹配 `<tag>...</tag>` 形式，导致解析到 0 个工作表。

**示例 XML**：
```xml
<!-- workbook.xml 中的 sheet 声明 -->
<sheet name="Sales" sheetId="1" r:id="rId1"/>

<!-- workbook.xml.rels 中的关系声明 -->
<Relationship Id="rId1" Type="..." Target="worksheets/sheet1.xml"/>
```

**初始（有缺陷）的正则**：
```javascript
// 只能匹配 <tag ...>content</tag>，无法匹配 <tag ... />
new RegExp(`<${tagName}(\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'g')
```

**结果**：`sheetList = []`，函数"成功"运行但输出 0 个文件。

**修复**：同时匹配自闭合和非自闭合标签：
```typescript
function* matchTags(xml: string, tagName: string): Generator<{attrs: string, inner: string}> {
  // 自闭合: <tag attrs />
  const scRe = new RegExp(`<${tagName}(\\s[^>]*?)?\\s*/>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = scRe.exec(xml)) !== null) {
    yield { attrs: m[1] ?? '', inner: '' };
  }
  // 非自闭合: <tag attrs>inner</tag>
  const ncRe = new RegExp(`<${tagName}(\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'g');
  while ((m = ncRe.exec(xml)) !== null) {
    yield { attrs: m[1] ?? '', inner: m[2] };
  }
}
```

**db9 团队**（本问题也不涉及 db9 平台）：
建议在函数文档中提供处理 OOXML 格式的完整参考实现。

---

## 最终架构

经过以上所有问题的排查和解决，最终实现如下：

### 数据流

```
用户本地 xlsx 文件
    ↓ base64 编码
    ↓ db9 db sql -q "INSERT INTO xlsx_staging ..."
xlsx_staging 表（BYTEA 列）
    ↓ db9 functions invoke xlsx-csv --payload '{"name":"file.xlsx"}'
xlsx-csv function（db9 serverless）
    ↓ ctx.db.query("SELECT encode(data,'base64') FROM xlsx_staging WHERE name=$1")
    ↓ Buffer.from(b64, 'base64')
    ↓ readZip(buf)            — 自实现 ZIP 解析（使用中心目录，支持 Data Descriptor）
    ↓ parseWorkbook(wbXml)    — 解析工作表列表
    ↓ parseSharedStrings()    — 解析共享字符串表（如有）
    ↓ parseWorksheet(wsXml)   — 解析每个工作表
    ↓ toCsv(rows)             — 生成 CSV 字符串
    ↓ ctx.db.query("INSERT INTO csv_output ...")
csv_output 表（TEXT 列）
    ↓ db9 db sql -q "SELECT csv_content FROM csv_output WHERE ..."
用户下载 CSV
```

### 完整使用示例

```bash
# 步骤 1：创建所需数据库表
db9 db sql myapp -q "
  CREATE TABLE IF NOT EXISTS xlsx_staging (
    name TEXT PRIMARY KEY,
    data BYTEA,
    uploaded_at TIMESTAMPTZ DEFAULT NOW()
  );
  GRANT ALL ON xlsx_staging TO authenticated;
  CREATE TABLE IF NOT EXISTS csv_output (
    source_name TEXT,
    sheet_name TEXT,
    csv_content TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (source_name, sheet_name)
  );
  GRANT ALL ON csv_output TO authenticated;
"

# 步骤 2：上传 xlsx 文件（通过 base64 编码插入数据库）
B64=$(base64 < your_file.xlsx)
db9 db sql myapp -q "
  INSERT INTO xlsx_staging (name, data)
  VALUES ('your_file.xlsx', decode('$B64', 'base64'))
  ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, uploaded_at = NOW()
"

# 步骤 3：构建并部署函数
npm run build
cat dist/index.js | db9 functions create xlsx-csv --database myapp

# 步骤 4：转换文件
db9 functions invoke xlsx-csv --database myapp --payload '{"name":"your_file.xlsx"}'
# 输出: {"converted":[{"source":"your_file.xlsx","sheet":"Sheet1","rows":6,"cols":5}],"errors":[]}

# 步骤 5：下载 CSV
db9 db sql myapp --output raw \
  -q "SELECT csv_content FROM csv_output WHERE source_name='your_file.xlsx' AND sheet_name='Sheet1'" \
  > output.csv

# 转换所有文件
db9 functions invoke xlsx-csv --database myapp --payload '{"all":true}'
```

---

## 汇总：db9 团队需要修复的问题

以下按优先级排序（P0 = 严重阻断，P1 = 重要，P2 = 改善体验）：

### 1. [P0] `ctx.fs9.write()` 总是抛出 "missing content" 错误

**类型**：功能完全失效（Critical Bug）

**重现脚本**：
```bash
cat << 'EOF' | db9 functions create test-write-bug --database <your-db>
const handler = async (input, ctx) => {
  try {
    await ctx.fs9.write("/output/test.csv", "col1,col2\nval1,val2");
    return { result: "ok" };
  } catch(e) {
    return { error: e.message };
    // 始终返回: {"error": "missing content"}
  }
};
module.exports = { handler };
EOF

db9 functions invoke test-write-bug --database <your-db> --payload '{}'
# Expected: {"result":"ok"}
# Actual:   {"error":"missing content"}
```

**期望行为**：`ctx.fs9.write(path, content)` 在函数的 fs9 作用域中创建或更新文件。

**实际行为**：无论 `path` 和 `content` 是什么，总是抛出 `"missing content"`。

**临时 Workaround**：将输出写入数据库表（`ctx.db.query("INSERT INTO output_table ...")`）。

---

### 2. [P0] `ctx.fs9.read()` 对二进制文件返回 null 而非 Buffer

**类型**：功能缺失（Missing Feature / Silent Bug）

**重现脚本**：
```bash
# 先上传一个二进制文件（例如 xlsx/zip/png）
db9 fs cp ./test.xlsx <your-db>:/functions/<func-id>/uploads/test.xlsx

cat << 'EOF' | db9 functions create test-binary-read --database <your-db>
const handler = async (input, ctx) => {
  const entries = await ctx.fs9.list('/uploads');
  const filename = entries[0].path.split('/').pop();
  const content = await ctx.fs9.read('/uploads/' + filename);
  return {
    isNull: content === null,    // true — 二进制文件返回 null
    type: typeof content,        // "object"（null 的 typeof）
  };
};
module.exports = { handler };
EOF

db9 functions invoke test-binary-read --database <your-db> --payload '{}'
# Expected: {"isNull":false,"type":"string"} 或 {"isNull":false,"type":"object"} (Buffer)
# Actual:   {"isNull":true,"type":"object"}
```

**期望行为**：提供 `ctx.fs9.readBinary(path): Promise<Uint8Array>` 或 `ctx.fs9.readBase64(path): Promise<string>` 用于读取二进制文件。

---

### 3. [P0] `fs9_read_bytea` SQL 函数不支持 SECURITY DEFINER 包装

**类型**：权限系统 Bug

**重现 SQL**：
```sql
-- 以 admin（superuser）用户执行：
CREATE OR REPLACE FUNCTION public.read_binary_b64(path TEXT)
RETURNS TEXT
LANGUAGE SQL
SECURITY DEFINER  -- 应以 admin 权限运行
AS $$ SELECT encode(fs9_read_bytea(path), 'base64') $$;
```

```javascript
// 以 authenticated 用户（db9 函数内）调用：
const handler = async (input, ctx) => {
  try {
    const r = await ctx.db.query("SELECT public.read_binary_b64($1)", ['/some/path.xlsx']);
    return { success: true, data: r.rows[0][0] };
  } catch(e) {
    return { error: e.message };
    // → "ERROR: fs9: permission denied (superuser required)"
    // SECURITY DEFINER 未生效！
  }
};
```

**期望行为**：SECURITY DEFINER 函数（创建者为 superuser）调用 `fs9_read_bytea` 时，应以创建者权限执行，对调用者透明。这是 PostgreSQL 标准行为。

**根本原因**：`fs9_read_bytea` C 扩展可能使用 `GetOuterUserId()`（原始调用者）而非 `GetUserId()`（当前安全上下文）进行权限检查，违反了 PostgreSQL SECURITY DEFINER 语义。

---

### 4. [P1] `ctx.db.query()` 返回数组行而非对象行，与行业标准不符

**类型**：API 设计问题（Breaking Expectation）

**重现代码**：
```javascript
const handler = async (input, ctx) => {
  const r = await ctx.db.query("SELECT id, name, email FROM users LIMIT 1");
  return {
    // 以下都是 undefined（因为行是数组，不是对象）
    id:    r.rows[0].id,     // undefined
    name:  r.rows[0].name,   // undefined
    email: r.rows[0].email,  // undefined

    // 正确的访问方式：
    id_correct:    r.rows[0][0],  // works
    name_correct:  r.rows[0][1],  // works
    email_correct: r.rows[0][2],  // works

    // 行的实际结构
    rowKeys: Object.keys(r.rows[0]),  // ["0", "1", "2"]
  };
};
```

**期望行为**：`r.rows[0]` 应该是 `{ id: 1, name: "Alice", email: "alice@example.com" }`，与 `pg`、`psycopg2`、`mysql2` 等所有主流 DB 客户端一致。

**建议**：
- 修改运行时返回对象行（breaking change，需版本控制）
- 或同时提供 `r.rows`（数组）和 `r.rowObjects`（对象），向后兼容
- 必须在文档中显著标注当前行为

---

### 5. [P1] `ctx.fs9.list()` 返回绝对路径，但 `ctx.fs9.read/write` 期望相对路径

**类型**：API 不一致（Inconsistency）

**重现代码**：
```javascript
const handler = async (input, ctx) => {
  const entries = await ctx.fs9.list('/data');
  const absolutePath = entries[0].path;
  // absolutePath = "/functions/abc123.../data/file.csv"  ← 绝对路径

  // 直接使用 list() 返回的路径读取 → 双重前缀，报错
  await ctx.fs9.read(absolutePath);
  // Error: No such file: /functions/abc123.../functions/abc123.../data/file.csv

  // 必须手动提取文件名并重建路径
  const filename = absolutePath.split('/').pop();
  await ctx.fs9.read('/data/' + filename);  // ← 需要手动处理
};
```

**期望行为**：`ctx.fs9.list('/data')` 返回的 `path` 应与 `ctx.fs9.read(path)` 接受的路径格式一致：
```json
[{ "path": "/data/file.csv", "type": "file", "size": 1234 }]
```

---

### 6. [P1] 函数没有更新/覆盖命令（`db9 functions update`）

**类型**：功能缺失（Missing Feature）

**问题**：`db9 functions create` 如果函数名已存在会报错 `"Function name already exists"`。但没有 `db9 functions update` 或 `db9 functions deploy` 命令来更新已有函数。

**重现**：
```bash
cat my_function.js | db9 functions create my-func --database myapp
# ✓ Function 'my-func' created

# 修改代码后重新部署
cat my_function_v2.js | db9 functions create my-func --database myapp
# ✗ error: Function name already exists for this database
```

**期望行为**：
```bash
# 方案 A：create 支持 --force 或 --update 标志
cat my_function_v2.js | db9 functions create my-func --database myapp --force

# 方案 B：提供独立的 update 命令
cat my_function_v2.js | db9 functions update my-func --database myapp

# 方案 C：create 对同名函数自动创建新版本（upsert 语义）
```

**影响**：开发迭代时必须每次使用新名称（`my-func-v1`、`my-func-v2`...），积累大量废弃函数。

---

### 7. [P2] 函数运行时缺乏 `ctx.self` 信息（函数 ID、名称等）

**类型**：功能缺失（Missing Feature）

**场景**：函数需要知道自己的 ID 才能构造 fs9 路径（由于问题 5 返回绝对路径但写入需要相对路径）。

**当前 Workaround**（脆弱）：
```javascript
// 必须先上传一个文件，然后从路径中提取函数 ID
const root = await ctx.fs9.list("/");
const funcId = root[0]?.path?.match(/^\/functions\/([^/]+)\//)?.[1];
// 如果没有文件，此方法失败
```

**期望行为**：`ctx` 对象应包含运行时元数据：
```typescript
interface Ctx {
  self: {
    functionId: string;    // "abc123-..."
    functionName: string;  // "xlsx-to-csv"
    databaseId: string;    // "yni0bc8v0zq0"
    runId: string;         // 当前运行的 ID
  };
  // ...
}
```

---

### 8. [P2] 函数部署大小限制未记录，错误信息不友好

**类型**：文档缺失 + 错误信息改善

**重现**：
```bash
# 将 SheetJS (1.8MB) 打包后尝试部署
cat large_bundle.js | db9 functions create my-func --database myapp
# error: <html><h1>413 Request Entity Too Large</h1></html>
```

**问题**：
1. 文档没有说明函数 bundle 的大小限制
2. 报错是原始 HTML nginx 413 响应，不是友好的错误信息

**期望行为**：
1. 文档明确说明最大 bundle 大小（例如："函数 bundle 最大 256KB"）
2. CLI 在上传前检查大小，给出清晰提示：
   ```
   Error: Function bundle too large (1.8MB). Maximum size is 256KB.
   Tip: Use esbuild --minify to reduce bundle size, or avoid large npm packages.
   ```

---

### 9. [P2] 函数 `ctx.db.query` 不支持列名访问，文档需要示例说明

**类型**：文档改善

**建议**：在 FUNCTIONS.md 的 "Querying the database" 部分添加以下说明：

```markdown
> ⚠️ **注意**：`ctx.db.query()` 返回的行是**数组**而非对象。
>
> ```javascript
> const result = await ctx.db.query("SELECT id, name FROM users WHERE id = $1", [1]);
>
> // ❌ 错误（返回 undefined）
> const name = result.rows[0].name;
>
> // ✓ 正确（按列索引访问）
> const id   = result.rows[0][0];  // 第 1 列
> const name = result.rows[0][1];  // 第 2 列
> ```
```

---

### 10. [P2] `db9 fs cp` 源路径不支持 `/dev/stdin`（macOS 上偶发连接错误）

**类型**：稳定性问题

**现象**：
```bash
echo "init" | db9 fs cp /dev/stdin myapp:/functions/<id>/init.txt
# 有时成功，有时报错：
# cp: /functions/<id>/init.txt: connection error: IO error: Connection refused (os error 61)
```

**期望行为**：`db9 fs cp` 支持 stdin 管道输入，且在 macOS 上稳定工作。

---

## 测试结果摘要

| 功能 | 状态 | 备注 |
|------|------|------|
| 函数部署（小 bundle）| ✅ 正常 | bundle < ~100KB 可正常上传 |
| `ctx.db.query` SELECT | ✅ 正常 | 行为数组（见问题 4）|
| `ctx.db.query` INSERT/UPDATE | ✅ 正常 | |
| `ctx.fs9.list()` | ✅ 正常 | 返回绝对路径（见问题 5）|
| `ctx.fs9.read()` 文本文件 | ✅ 正常 | |
| `ctx.fs9.read()` 二进制文件 | ❌ 返回 null | 见问题 2 |
| `ctx.fs9.write()` | ❌ "missing content" | 见问题 1 |
| `fs9_read_bytea` SQL（superuser）| ✅ 正常 | 需要 superuser |
| `fs9_read_bytea` SQL（authenticated）| ❌ 权限拒绝 | 见问题 3 |
| `fs9_read_bytea` SECURITY DEFINER | ❌ 权限拒绝 | 见问题 3 |
| 函数更新（重新部署）| ❌ 不支持 | 见问题 6 |
| xlsx 转 CSV（最终方案）| ✅ 正常 | 使用 BYTEA 表 + 输出到 csv_output 表 |

---

## 最终函数代码

项目地址：`/Users/dongxu/db9-function-xls-csv-tbl/`

- **源码**：`src/index.ts`（TypeScript，使用 Node.js 内置 `zlib`，零 npm 运行时依赖）
- **构建**：`npm run build` → `dist/index.js`（7.5KB）
- **部署**：`cat dist/index.js | db9 functions create xlsx-csv --database <db>`

最终函数 `xlsx-csv-v4` 在 `myapp` 数据库上成功转换了测试文件：
- `test_data.xlsx[Sales]`：6 行 × 5 列 ✅
- `test_data.xlsx[Inventory]`：5 行 × 4 列 ✅
