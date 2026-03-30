import { inflateRawSync } from "zlib";

// ─── ZIP reader using central directory (handles data-descriptor entries) ────

function readZip(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();

  // 1. Find the End of Central Directory (EOCD): signature PK\x05\x06
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (
      buf[i] === 0x50 &&
      buf[i + 1] === 0x4b &&
      buf[i + 2] === 0x05 &&
      buf[i + 3] === 0x06
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return files;

  const cdEntries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  // 2. Walk the central directory — it always has accurate compressed sizes
  let pos = cdOffset;
  for (let e = 0; e < cdEntries; e++) {
    if (
      buf[pos] !== 0x50 ||
      buf[pos + 1] !== 0x4b ||
      buf[pos + 2] !== 0x01 ||
      buf[pos + 3] !== 0x02
    )
      break;

    const compression = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const fnLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const filename = buf.slice(pos + 46, pos + 46 + fnLen).toString("utf8");

    // 3. Jump to local file header to find exact data start
    const lh = localOffset;
    const lhFnLen = buf.readUInt16LE(lh + 26);
    const lhExtraLen = buf.readUInt16LE(lh + 28);
    const dataStart = lh + 30 + lhFnLen + lhExtraLen;

    if (compressedSize > 0) {
      const compressed = buf.slice(dataStart, dataStart + compressedSize);
      try {
        files.set(
          filename,
          compression === 0 ? compressed : inflateRawSync(compressed)
        );
      } catch {
        // skip unreadable entry
      }
    }

    pos += 46 + fnLen + extraLen + commentLen;
  }

  return files;
}

// ─── Minimal XML helpers ──────────────────────────────────────────────────────

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function decodeXml(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m);
}

function* matchTags(
  xml: string,
  tagName: string
): Generator<{ attrs: string; inner: string }> {
  // Self-closing: <tag attrs />
  const scRe = new RegExp(`<${tagName}(\\s[^>]*?)?\\s*/>`, "g");
  let m: RegExpExecArray | null;
  while ((m = scRe.exec(xml)) !== null) {
    yield { attrs: m[1] ?? "", inner: "" };
  }
  // Non-self-closing: <tag attrs>inner</tag>
  const ncRe = new RegExp(
    `<${tagName}(\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`,
    "g"
  );
  while ((m = ncRe.exec(xml)) !== null) {
    yield { attrs: m[1] ?? "", inner: m[2] };
  }
}

function attrVal(attrs: string, name: string): string {
  const m = new RegExp(`\\b${name}="([^"]*)"`, "i").exec(attrs);
  return m ? decodeXml(m[1]) : "";
}

// ─── OOXML parsers ────────────────────────────────────────────────────────────

function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  for (const { inner } of matchTags(xml, "si")) {
    let val = "";
    const tRe = /<t(?:\s[^>]*)?>([^<]*)<\/t>/g;
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(inner)) !== null) {
      val += decodeXml(tm[1]);
    }
    strings.push(val);
  }
  return strings;
}

function parseSheetList(xml: string): Array<{ name: string; id: string }> {
  const sheets: Array<{ name: string; id: string }> = [];
  for (const { attrs } of matchTags(xml, "sheet")) {
    const name = attrVal(attrs, "name");
    const id = attrVal(attrs, "r:id") || attrVal(attrs, "sheetId");
    sheets.push({ name, id });
  }
  return sheets;
}

function colIndex(label: string): number {
  let n = 0;
  for (const ch of label.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

function parseWorksheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];

  for (const row of matchTags(xml, "row")) {
    const rowIdx = parseInt(attrVal(row.attrs, "r") || "0", 10) - 1;
    const cells: Record<number, string> = {};

    for (const cell of matchTags(row.inner, "c")) {
      const ref = attrVal(cell.attrs, "r");
      const type = attrVal(cell.attrs, "t");
      const colMatch = /^([A-Za-z]+)/.exec(ref);
      if (!colMatch) continue;
      const col = colIndex(colMatch[1]);

      let value = "";
      if (type === "inlineStr") {
        const tMatch = /<t(?:\s[^>]*)?>([^<]*)<\/t>/.exec(cell.inner);
        value = tMatch ? decodeXml(tMatch[1]) : "";
      } else {
        const vMatch = /<v(?:\s[^>]*)?>([^<]*)<\/v>/.exec(cell.inner);
        const raw = vMatch ? vMatch[1] : "";
        if (type === "s") {
          value = shared[parseInt(raw, 10)] ?? "";
        } else if (type === "b") {
          value = raw === "1" ? "TRUE" : "FALSE";
        } else {
          value = decodeXml(raw);
        }
      }
      cells[col] = value;
    }

    if (Object.keys(cells).length === 0) continue;
    const maxCol = Math.max(...Object.keys(cells).map(Number));
    const arr = Array.from({ length: maxCol + 1 }, (_, i) => cells[i] ?? "");
    while (rows.length <= rowIdx) rows.push([]);
    rows[rowIdx] = arr;
  }

  return rows;
}

function toCsv(rows: string[][]): string {
  return rows
    .filter((r) => r.some((v) => v !== ""))
    .map((row) =>
      row
        .map((v) => {
          if (/[,"\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
          return v;
        })
        .join(",")
    )
    .join("\n");
}

// ─── db9 handler ─────────────────────────────────────────────────────────────
//
// Input workflow:
//   1. Upload xlsx binary to the staging table:
//        B64=$(base64 < file.xlsx)
//        db9 db sql <db> -q "INSERT INTO xlsx_staging(name,data) VALUES('file.xlsx',decode('$B64','base64')) ON CONFLICT(name) DO UPDATE SET data=EXCLUDED.data"
//   2. Invoke:  { "name": "file.xlsx" }  or  { "all": true }
//
// Output:
//   Converted CSVs are written to the `csv_output` table (source_name, sheet_name, csv_content).
//   Download a CSV:
//        db9 db sql <db> --output raw -q "SELECT csv_content FROM csv_output WHERE source_name='file.xlsx' AND sheet_name='Sheet1'"
//        or: db9 db sql <db> -q "..." > output.csv

interface Ctx {
  db: {
    // Rows are arrays: r.rows[i][j] for column j (NOT objects)
    query(
      sql: string,
      params?: unknown[]
    ): Promise<{ rows: unknown[][]; rowCount: number }>;
  };
}

interface Input {
  /** Single file name to convert — must be in `xlsx_staging` table */
  name?: string;
  /** Convert all files currently in `xlsx_staging` table */
  all?: boolean;
}

interface ConvertedSheet {
  source: string;
  sheet: string;
  rows: number;
  cols: number;
}

interface Output {
  converted: ConvertedSheet[];
  errors: Array<{ file: string; error: string }>;
}

async function convertOne(
  name: string,
  ctx: Ctx,
  converted: ConvertedSheet[],
  errors: Array<{ file: string; error: string }>
) {
  try {
    const r = await ctx.db.query(
      "SELECT encode(data, 'base64') FROM xlsx_staging WHERE name = $1",
      [name]
    );
    const b64 = r.rows[0]?.[0] as string | undefined;
    if (!b64) throw new Error("not found in xlsx_staging");

    const buf = Buffer.from(b64, "base64");
    const zipFiles = readZip(buf);

    const wbXml = zipFiles.get("xl/workbook.xml")?.toString("utf8") ?? "";
    const sheetList = parseSheetList(wbXml);
    console.log(`  ${name}: ${sheetList.length} sheet(s) – ${sheetList.map((s) => s.name).join(", ")}`);

    const ssXml =
      zipFiles.get("xl/sharedStrings.xml")?.toString("utf8") ?? "";
    const shared = ssXml ? parseSharedStrings(ssXml) : [];

    const relsXml =
      zipFiles.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
    const idToTarget = new Map<string, string>();
    for (const { attrs } of matchTags(relsXml, "Relationship")) {
      idToTarget.set(attrVal(attrs, "Id"), attrVal(attrs, "Target"));
    }

    for (let si = 0; si < sheetList.length; si++) {
      const sheet = sheetList[si];
      const target =
        idToTarget.get(sheet.id) ?? `worksheets/sheet${si + 1}.xml`;
      const wsPath = target.startsWith("xl/") ? target : `xl/${target}`;
      const wsXml = zipFiles.get(wsPath)?.toString("utf8") ?? "";
      if (!wsXml) {
        console.error(`  Could not find sheet "${sheet.name}" at ${wsPath}`);
        continue;
      }

      const rows = parseWorksheet(wsXml, shared);
      const csv = toCsv(rows);
      const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);

      // Write to csv_output table
      await ctx.db.query(
        `INSERT INTO csv_output (source_name, sheet_name, csv_content)
         VALUES ($1, $2, $3)
         ON CONFLICT (source_name, sheet_name)
         DO UPDATE SET csv_content = EXCLUDED.csv_content, created_at = NOW()`,
        [name, sheet.name, csv]
      );
      converted.push({ source: name, sheet: sheet.name, rows: rows.length, cols: maxCols });
      console.log(`  ✓ ${name}[${sheet.name}]: ${rows.length} rows × ${maxCols} cols`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${name}: ${msg}`);
    errors.push({ file: name, error: msg });
  }
}

const handler = async (input: Input, ctx: Ctx): Promise<Output> => {
  const converted: ConvertedSheet[] = [];
  const errors: Array<{ file: string; error: string }> = [];

  if (input.name) {
    await convertOne(input.name, ctx, converted, errors);
  } else if (input.all) {
    const r = await ctx.db.query("SELECT name FROM xlsx_staging ORDER BY name");
    const names = r.rows.map((row) => row[0] as string);
    console.log(`Processing ${names.length} file(s) from xlsx_staging...`);
    for (const n of names) {
      await convertOne(n, ctx, converted, errors);
    }
  } else {
    return {
      converted: [],
      errors: [
        {
          file: "",
          error: 'Provide { "name": "file.xlsx" } or { "all": true }',
        },
      ],
    };
  }

  console.log(
    `Done: ${converted.length} sheet(s) converted, ${errors.length} error(s).`
  );
  return { converted, errors };
};

module.exports = { handler };
