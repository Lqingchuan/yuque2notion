#!/usr/bin/env node
// ============================================================
// 图片修复器（导入后收尾，三合一）：
//   A. external 图片块 URL 有本地文件 → 上传转存为 file_upload
//   B. 段落纯文本恰好是图片 URL（markdown 解析降级产物）→ 删除文本段+原位插入图片块
//   C. 行内图片链接 → 插入图片块 + 去掉链接属性
// 用法：
//   export NOTION_TOKEN="ntn_xxx"
//   node 07_fix_images.mjs docs_final.json   （需要 06 生成的 import_state.json）
// 断点续传：state.imgFix
// ============================================================
import fs from "node:fs";
import path from "node:path";

const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) { console.error("缺少 NOTION_TOKEN"); process.exit(1); }
const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";
const [, , inFile] = process.argv;
const imageMap = JSON.parse(fs.readFileSync(process.env.IMAGE_MAP || "image_map.json", "utf8"));
const imageDir = process.env.IMAGE_DIR || "images";
const state = JSON.parse(fs.readFileSync("import_state.json", "utf8"));
state.imgFix = state.imgFix || {};
const saveState = () => fs.writeFileSync("import_state.json", JSON.stringify(state, null, 1));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
const wait = async () => { const g = Date.now() - last; if (g < 340) await sleep(340 - g); last = Date.now(); };
async function notion(method, urlPath, body, isForm, skipWait) {
  for (let i = 1; i <= 5; i++) {
    if (!skipWait) await wait();
    const headers = { Authorization: `Bearer ${TOKEN}`, "Notion-Version": VERSION };
    let payload;
    if (isForm) payload = body;
    else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
    let res;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 60000);
      res = await fetch(API + urlPath, { method, headers, body: payload, signal: ctrl.signal });
      clearTimeout(t);
    } catch (e) { if (i === 5) throw e; await sleep(2000 * i); continue; }
    if (res.status === 429 || res.status >= 500) { await sleep((parseInt(res.headers.get("retry-after") || "1", 10) || 2) * 1000); continue; }
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }
  throw new Error("retries exhausted");
}

const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" };
const uploadCache = new Map();
let upLast = 0, uploaded = 0;
async function upload(url) {
  if (uploadCache.has(url)) return uploadCache.get(url);
  const info = imageMap[url];
  if (!info) return null;
  const ext = info.file.split(".").pop().toLowerCase();
  const mime = MIME[ext];
  if (!mime) return null;
  const buf = fs.readFileSync(path.join(process.cwd(), imageDir, info.file));
  if (buf.length > 50 * 1024 * 1024) return null;
  const g = Date.now() - upLast; if (g < 150) await sleep(150 - g); upLast = Date.now();
  const created = await notion("POST", "/file_uploads", { mode: "single_part", filename: info.file, content_type: mime }, undefined, true);
  if (created.status !== 200) return null;
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: mime }), info.file);
  const sent = await notion("POST", `/file_uploads/${created.json.id}/send`, fd, true, true);
  if (sent.status !== 200) return null;
  uploadCache.set(url, created.json.id);
  uploaded++;
  return created.json.id;
}
const imageBlock = (id) => ({ object: "block", type: "image", image: { type: "file_upload", file_upload: { id } } });

async function getPageBlocks(pid) {
  const blocks = [];
  let cursor = null;
  for (let i = 0; i < 30; i++) {
    const r = await notion("GET", `/blocks/${pid}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    if (r.status !== 200) return null;
    blocks.push(...(r.json.results || []));
    if (!r.json.has_more) break;
    cursor = r.json.next_cursor;
  }
  return blocks;
}

async function fixPage(pid) {
  const blocks = await getPageBlocks(pid);
  if (!blocks) return 0;
  let fixed = 0;
  for (const b of blocks) {
    // A: external 图片块
    if (b.type === "image" && b.image?.type === "external") {
      const url = b.image.external.url;
      if (!imageMap[url]) continue;
      const id = await upload(url);
      if (!id) continue;
      const r = await notion("PATCH", `/blocks/${b.id}`, { image: { type: "file_upload", file_upload: { id } } });
      if (r.status === 200) fixed++;
      continue;
    }
    const t = b[b.type];
    const rts = (t && t.rich_text) || [];
    // B: 段落纯文本 = 图片 URL
    if (b.type === "paragraph" && rts.length === 1) {
      const txt = (rts[0]?.text?.content || "").trim();
      if (imageMap[txt] && txt.startsWith("http")) {
        const id = await upload(txt);
        if (id) {
          const ins = await notion("PATCH", `/blocks/${pid}/children`, { after: b.id, children: [imageBlock(id)] });
          if (ins.status === 200) { await notion("DELETE", `/blocks/${b.id}`); fixed++; }
        }
        continue;
      }
    }
    // C: 行内图片链接
    const hasImgLink = rts.some((rt) => {
      const u = rt?.text?.link?.url || rt?.link?.url;
      return u && imageMap[u] && /^https?:\/\//.test(u);
    });
    if (hasImgLink && ["paragraph","heading_1","heading_2","heading_3","quote","callout","bulleted_list_item","numbered_list_item","to_do"].includes(b.type)) {
      const newRich = [], toInsert = [];
      for (const rt of rts) {
        const u = rt?.text?.link?.url || rt?.link?.url;
        if (u && imageMap[u] && /^https?:\/\//.test(u)) {
          const id = await upload(u);
          if (id) toInsert.push(id);
          const clone = JSON.parse(JSON.stringify(rt));
          if (clone.text) delete clone.text.link;
          if (clone.link) delete clone.link;
          newRich.push(clone);
        } else newRich.push(rt);
      }
      const r1 = await notion("PATCH", `/blocks/${b.id}`, { [b.type]: { rich_text: newRich } });
      if (r1.status !== 200) continue;
      for (const id of toInsert)
        await notion("PATCH", `/blocks/${pid}/children`, { after: b.id, children: [imageBlock(id)] });
      fixed += toInsert.length;
    }
  }
  return fixed;
}

async function main() {
  const all = Object.entries(state.pages || {});
  const pages = all.filter(([k]) => !state.imgFix[k]);
  console.log(`共 ${all.length} 页，待处理 ${pages.length}`);
  let idx = 0, done = 0, totalFixed = 0;
  const t0 = Date.now();
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= pages.length) return;
      const [key, pid] = pages[i];
      try { totalFixed += await fixPage(pid); } catch (e) { console.log(`[err] ${key}: ${String(e).slice(0, 90)}`); continue; }
      state.imgFix[key] = true;
      done++;
      if (done % 20 === 0) {
        saveState();
        console.log(`进度 ${done}/${pages.length} | 修复 ${totalFixed} | 上传 ${uploaded} | ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  saveState();
  console.log(`\n完成：修复 ${totalFixed} 个图片块，上传 ${uploaded} 张`);
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
