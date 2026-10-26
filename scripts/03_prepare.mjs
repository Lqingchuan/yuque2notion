#!/usr/bin/env node
// ============================================================
// 合并清洗：docs_raw.json（01 抓取产物）→ docs_final.json
// - lake content → Markdown
// - 去除 data:URI 内嵌装饰图
// - 按 (bookId, slug) 去重
// 依赖：npm i turndown
// 用法：node 03_prepare.mjs docs_raw.json docs_final.json
// ============================================================
import fs from "node:fs";
import { lakeToMarkdown } from "./02_lake_convert.mjs";

const [, , inFile, outFile] = process.argv;
if (!inFile || !outFile) {
  console.error("用法: node 03_prepare.mjs <docs_raw.json> <docs_final.json>");
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(inFile, "utf8"));
const seen = new Set();
const out = [];
let converted = 0, empty = 0;

for (const d of raw) {
  if (d.slug) {
    const k = `${d.bookId}|${d.slug}`;
    if (seen.has(k)) continue;
    seen.add(k);
  }
  if (d.type !== "DOC") { out.push({ ...d, md: "", source: "title" }); continue; }

  let md = lakeToMarkdown(d.content || "");
  converted++;
  // 去掉 data:URI 内嵌图片（网页剪藏的装饰图/SVG，Notion 无法承载）
  md = md.replace(/!\[[^\]]*\]\(data:[^)]*\)/g, "");
  // 语雀导出常见 <br> 残留
  md = md.replace(/<br\s*\/?>/gi, "\n\n");
  md = md.replace(/\n{3,}/g, "\n\n").trim();
  if (!md) { empty++; md = ""; }
  out.push({ ...d, md, source: md ? "detail" : "empty" });
}

fs.writeFileSync(outFile, JSON.stringify(out, null, 0));
console.log(`输出 ${out.length} 条 → ${outFile}`);
console.log(`转换 ${converted} 篇，其中空文档 ${empty} 篇`);
// 顺手导出全部图片 URL（去重）供下载
const urls = new Set();
for (const d of out) {
  for (const m of (d.md || "").matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)) urls.add(m[1]);
}
fs.writeFileSync(outFile.replace(/\.json$/, ".imgurls.txt"), [...urls].join("\n"));
console.log(`图片 URL ${urls.size} 个 → ${outFile.replace(/\.json$/, ".imgurls.txt")}`);
