import { inflateRawSync } from "zlib";

// ─── ZIP / OOXML parsers ──────────────────────────────────────────────────────

function readZip(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i]===0x50&&buf[i+1]===0x4b&&buf[i+2]===0x05&&buf[i+3]===0x06) { eocd=i; break; }
  }
  if (eocd < 0) return files;
  const cdEntries = buf.readUInt16LE(eocd+10), cdOffset = buf.readUInt32LE(eocd+16);
  let pos = cdOffset;
  for (let e = 0; e < cdEntries; e++) {
    if (buf[pos]!==0x50||buf[pos+1]!==0x4b||buf[pos+2]!==0x01||buf[pos+3]!==0x02) break;
    const compression=buf.readUInt16LE(pos+10), compressedSize=buf.readUInt32LE(pos+20);
    const fnLen=buf.readUInt16LE(pos+28), extraLen=buf.readUInt16LE(pos+30), commentLen=buf.readUInt16LE(pos+32);
    const localOffset=buf.readUInt32LE(pos+42);
    const filename=buf.slice(pos+46,pos+46+fnLen).toString("utf8");
    const lhFnLen=buf.readUInt16LE(localOffset+26), lhExtraLen=buf.readUInt16LE(localOffset+28);
    const dataStart=localOffset+30+lhFnLen+lhExtraLen;
    if (compressedSize>0) {
      const compressed=buf.slice(dataStart,dataStart+compressedSize);
      try { files.set(filename, compression===0?compressed:inflateRawSync(compressed)); } catch {}
    }
    pos += 46+fnLen+extraLen+commentLen;
  }
  return files;
}

const XML_ENT: Record<string,string> = {"&amp;":"&","&lt;":"<","&gt;":">","&quot;":'"',"&apos;":"'"};
const decodeXml = (s: string) => s.replace(/&(?:amp|lt|gt|quot|apos);/g, m=>XML_ENT[m]??m);

function* matchTags(xml: string, tag: string): Generator<{attrs:string;inner:string}> {
  let m: RegExpExecArray|null;
  const sc=new RegExp(`<${tag}(\\s[^>]*?)?\\s*/>`, "g");
  while ((m=sc.exec(xml))!==null) yield {attrs:m[1]??"",inner:""};
  const nc=new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "g");
  while ((m=nc.exec(xml))!==null) yield {attrs:m[1]??"",inner:m[2]};
}

const attrVal = (attrs: string, name: string) =>
  (new RegExp(`\\b${name}="([^"]*)"`, "i").exec(attrs)?.[1] ?? "");

function parseSharedStrings(xml: string) {
  return [...matchTags(xml,"si")].map(({inner}) => {
    let v=""; const re=/<t(?:\s[^>]*)?>([^<]*)<\/t>/g; let m: RegExpExecArray|null;
    while((m=re.exec(inner))!==null) v+=decodeXml(m[1]);
    return v;
  });
}

function parseSheetList(xml: string) {
  return [...matchTags(xml,"sheet")].map(({attrs}) => ({
    name: attrVal(attrs,"name"),
    id:   attrVal(attrs,"r:id") || attrVal(attrs,"sheetId"),
  }));
}

function colIndex(label: string) {
  let n=0; for (const ch of label.toUpperCase()) n=n*26+(ch.charCodeAt(0)-64); return n-1;
}

function parseWorksheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const row of matchTags(xml,"row")) {
    const ri = parseInt(attrVal(row.attrs,"r")||"0",10)-1;
    const cells: Record<number,string> = {};
    for (const cell of matchTags(row.inner,"c")) {
      const ref=attrVal(cell.attrs,"r"), type=attrVal(cell.attrs,"t");
      const cm=/^([A-Za-z]+)/.exec(ref); if (!cm) continue;
      const col=colIndex(cm[1]);
      let v="";
      if (type==="inlineStr") { const tm=/<t(?:\s[^>]*)?>([^<]*)<\/t>/.exec(cell.inner); v=tm?decodeXml(tm[1]):""; }
      else { const vm=/<v(?:\s[^>]*)?>([^<]*)<\/v>/.exec(cell.inner); const raw=vm?vm[1]:"";
        v = type==="s"?(shared[parseInt(raw,10)]??""): type==="b"?(raw==="1"?"TRUE":"FALSE"):decodeXml(raw); }
      cells[col]=v;
    }
    if (!Object.keys(cells).length) continue;
    const maxCol=Math.max(...Object.keys(cells).map(Number));
    const arr=Array.from({length:maxCol+1},(_,i)=>cells[i]??"");
    while(rows.length<=ri) rows.push([]); rows[ri]=arr;
  }
  return rows;
}

function toCsv(rows: string[][]) {
  return rows.filter(r=>r.some(v=>v!==""))
    .map(r=>r.map(v=>/[,"\n\r]/.test(v)?`"${v.replace(/"/g,'""')}"`:v).join(","))
    .join("\n");
}

// ─── Handler ──────────────────────────────────────────────────────────────────
//
// Pure fs9 workflow — no SQL:
//   Upload:  db9 fs cp file.xlsx <db>:/uploads/file.xlsx
//   Deploy:  cat dist/index-fs9.js | db9 functions create xlsx-csv-fs9 \
//              --database <db> --fs9-scope /uploads:ro --fs9-scope /output:rw
//   Invoke:  { "name": "file.xlsx" }  or  { "all": true }
//   Output:  CSV files written to /output/ in the database fs9
//   Read:    db9 fs cp <db>:/output/file_Sheet1.csv ./

interface Ctx {
  fs9: {
    list(path: string): Promise<Array<{path:string; type:string; size?:number}>>;
    /** Returns UTF-8 string content, or null for binary/not-found */
    read(path: string): Promise<string | null>;
    /** Returns base64-encoded file content — works for binary files */
    readBase64(path: string): Promise<string | null>;
    /** Writes text content to path (creates or overwrites) */
    write(path: string, content: string): Promise<void>;
  };
}

interface Input {
  name?: string;   // single file under /uploads/
  all?:  boolean;  // convert all xlsx files under /uploads/
}

const handler = async (input: Input, ctx: Ctx) => {
  if (!input.name && !input.all) {
    return { error: 'Provide { "name": "file.xlsx" } or { "all": true }' };
  }

  // 1. Discover which files to convert
  const uploads = await ctx.fs9.list("/uploads");
  const files = uploads.filter(e => {
    const name = e.path.split("/").pop() ?? "";
    return e.type === "file"
      && name.endsWith(".xlsx")
      && (!input.name || name === input.name);
  });

  if (files.length === 0) {
    return { error: `No xlsx files found in /uploads${input.name ? ` matching '${input.name}'` : ""}` };
  }

  const converted: Array<{source:string; sheet:string; path:string; rows:number; cols:number}> = [];
  const errors: Array<{file:string; error:string}> = [];

  for (const entry of files) {
    const filename = entry.path.split("/").pop()!;
    // list() returns absolute paths; read/readBase64 take relative paths (Bug #5 workaround)
    const readPath = "/uploads/" + filename;

    try {
      // 2. Read xlsx binary via ctx.fs9.readBase64
      //    (ctx.fs9.read returns null for binary — use readBase64 instead)
      const b64 = await ctx.fs9.readBase64(readPath);
      if (b64 === null) throw new Error(`readBase64 returned null for '${readPath}'`);
      console.log(`  read ${filename}: ${b64.length} base64 chars`);

      const buf = Buffer.from(b64, "base64");

      // 3. Parse OOXML
      const zip       = readZip(buf);
      const wbXml     = zip.get("xl/workbook.xml")?.toString("utf8") ?? "";
      const sheetList = parseSheetList(wbXml);
      const shared    = parseSharedStrings(zip.get("xl/sharedStrings.xml")?.toString("utf8") ?? "");
      const relsXml   = zip.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
      const idToTarget = new Map<string,string>();
      for (const {attrs} of matchTags(relsXml,"Relationship"))
        idToTarget.set(attrVal(attrs,"Id"), attrVal(attrs,"Target"));
      console.log(`  ${filename}: ${sheetList.length} sheet(s) — ${sheetList.map(s=>s.name).join(", ")}`);

      const base = filename.replace(/\.xlsx$/i, "");

      for (let si = 0; si < sheetList.length; si++) {
        const sheet  = sheetList[si];
        const target = idToTarget.get(sheet.id) ?? `worksheets/sheet${si+1}.xml`;
        const wsPath = target.startsWith("xl/") ? target : `xl/${target}`;
        const wsXml  = zip.get(wsPath)?.toString("utf8") ?? "";
        if (!wsXml) { console.error(`  sheet '${sheet.name}' not found at ${wsPath}`); continue; }

        const rows    = parseWorksheet(wsXml, shared);
        const csv     = toCsv(rows);
        const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
        const csvName = sheetList.length === 1 ? `${base}.csv` : `${base}_${sheet.name}.csv`;
        const outPath = `/output/${csvName}`;

        // 4. Write CSV to fs9
        await ctx.fs9.write(outPath, csv);
        converted.push({ source: filename, sheet: sheet.name, path: outPath, rows: rows.length, cols: maxCols });
        console.log(`  ✓ ${filename}[${sheet.name}] → ${outPath}  (${rows.length}r × ${maxCols}c)`);
      }
    } catch (err: any) {
      errors.push({ file: filename, error: err.message });
      console.error(`  ✗ ${filename}: ${err.message}`);
    }
  }

  return { converted, errors };
};

module.exports = { handler };
