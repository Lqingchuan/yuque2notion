#!/usr/bin/env node
// ============================================================
// Notion 导入器：docs_final.json → Notion（层级还原 + 图片转存）
// 用法：
//   export NOTION_TOKEN="ntn_xxx"        # notion.so/developers/tokens 创建个人访问令牌
//   export ROOT_PAGE_ID="xxxxxxxx"       # 目标父页面 id（也可留空自动建顶级页「语雀迁移」）
//   node 06_import_notion.mjs docs_final.json
//   可选 --fresh 重跑某库；断点续传自动进行（state.json）
// 依赖：npm i @tryfabric/martian
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { markdownToBlocks } from "@tryfabric/martian";

const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) { console.error("缺少 NOTION_TOKEN 环境变量"); process.exit(1); }
const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";
const [, , inFile] = process.argv;
if (!inFile) { console.error("用法: node 06_import_notion.mjs <docs_final.json>"); process.exit(1); }

// ---------- 配置 ----------
const CONFIG = {
  rootPageId: process.env.ROOT_PAGE_ID || null,  // 留空自动创建
  rootTitle: process.env.ROOT_TITLE || "语雀迁移",
  imageMapFile: process.env.IMAGE_MAP || "image_map.json",
  imageDir: process.env.IMAGE_DIR || "images",
  footer: true,            // 文档尾部附加原文链接与日期
  maxDocChars: 200000,     // 超长文档截断阈值（防转换卡死）
  uploadExternal: false,   // true=连 nlark 公网图也上传；false=公网图保留外链（省配额）
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE_FILE = "import_state.json";
let state = {};
try { state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));

let imageMap = {};
try { imageMap = JSON.parse(fs.readFileSync(CONFIG.imageMapFile, "utf8")); } catch {}

// ---------- 限速与请求 ----------
let last = 0;
const wait = async () => {
  const g = Date.now() - last;
  if (g < 340) await sleep(340 - g);   // Notion 官方 3 rps
  last = Date.now();
};
async function notion(method, urlPath, body, isForm, skipWait) {
  for (let i = 1; i <= 6; i++) {
    if (!skipWait) await wait();
    const headers = { Authorization: `Bearer ${TOKEN}`, "Notion-Version": VERSION };
    let payload;
    if (isForm) payload = body;                       // FormData，fetch 自动设 boundary
    else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
    let res;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60000);
      res = await fetch(API + urlPath, { method, headers, body: payload, signal: ctrl.signal });
      clearTimeout(timer);
    } catch (e) {
      if (i === 6) throw e;
      await sleep(2000 * i); continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep((parseInt(res.headers.get("retry-after") || "1", 10) || 2) * 1000);
      continue;
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(`Notion ${res.status}: ${j.message || ""}`); e.status = res.status; throw e; }
    return j;
  }
  throw new Error("unreachable");
}

// ---------- 图片上传（file_uploads 接口，multipart） ----------
const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" };
const uploadCache = new Map();
let upLast = 0;
async function uploadImage(url) {
  if (uploadCache.has(url)) return uploadCache.get(url);
  const info = imageMap[url];
  if (!info) return null;
  const ext = info.file.split(".").pop().toLowerCase();
  const mime = MIME[ext];
  if (!mime) return null;
  const buf = fs.readFileSync(path.join(CONFIG.imageDir, info.file));
  if (buf.length > 50 * 1024 * 1024) return null;
  const gap = Date.now() - upLast;
  if (gap < 150) await sleep(150 - gap);   // 文件接口配额独立于 3rps，可稍快
  upLast = Date.now();
  const created = await notion("POST", "/file_uploads", { mode: "single_part", filename: info.file, content_type: mime }, undefined, true);
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: mime }), info.file);
  const sent = await notion("POST", `/file_uploads/${created.id}/send`, fd, true, true);
  uploadCache.set(url, sent.id);
  return sent.id;
}

// ---------- Markdown → 块（含 Notion 校验规则修复） ----------
const URL_OK = /^(https?:\/\/|mailto:|tel:)/i;
const URL_CHARS = /^[\x21-\x7E]*$/;
const URL_BAD = /[\s"<>{}`|\\^\[\]]/;
function urlValid(u) {
  if (!u || !URL_OK.test(u) || !URL_CHARS.test(u) || URL_BAD.test(u) || u.length > 1900) return false;
  try { return !!new URL(u).hostname; } catch { return false; }
}
function sanitizeLinks(blocks) {
  for (const b of blocks) {
    const t = b[b.type];
    if (t?.rich_text) for (const rt of t.rich_text) {
      if (rt?.text?.link && !urlValid(rt.text.link.url)) delete rt.text.link;
      if (rt?.link && !urlValid(rt.link.url)) delete rt.link;
    }
    if (b.children?.length) sanitizeLinks(b.children);
    if (t?.children?.length) sanitizeLinks(t.children);
  }
  return blocks;
}
const NO_NEST = ["quote", "paragraph", "heading_1", "heading_2", "heading_3", "callout"];
function flatten(blocks) {
  // martian 把子块放在 block[type].children；quote/段落等不允许嵌套子块，拍平
  const out = [];
  for (const b of blocks) {
    const t = b[b.type];
    if (t?.children?.length && NO_NEST.includes(b.type)) { out.push(b, ...flatten(t.children)); delete t.children; delete b.children; }
    else { if (t?.children?.length) t.children = flatten(t.children); if (b.children?.length) b.children = flatten(b.children); out.push(b); }
  }
  return out;
}
function splitRichText(blocks) {
  for (const b of blocks) {
    const t = b[b.type];
    if (!t?.rich_text) continue;
    const out = [];
    for (const rt of t.rich_text) {
      const c = rt.text?.content;
      if (c && c.length > 1900) for (let i = 0; i < c.length; i += 1900)
        out.push({ ...rt, text: { ...rt.text, content: c.slice(i, i + 1900) } });
      else out.push(rt);
    }
    t.rich_text = out.slice(0, 100);
  }
}
async function localizeImages(blocks) {
  let n = 0;
  for (const b of blocks) {
    if (b.type === "image" && b.image?.type === "external") {
      const url = b.image.external.url;
      const keepExternal = !CONFIG.uploadExternal && url.includes("nlark.com");
      if (imageMap[url] && !keepExternal) {
        const id = await uploadImage(url);
        if (id) { b.image = { type: "file_upload", file_upload: { id } }; n++; }
      }
    }
    if (b.children?.length) n += await localizeImages(b.children);
    if (b[b.type]?.children?.length) n += await localizeImages(b[b.type].children);
  }
  return n;
}
const truncate = (s, n) => {
  if (!s) return "(无标题)";
  const cut = Array.from(s).length > n ? Array.from(s).slice(0, n - 1).join("") + "…" : s;
  return cut.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
};

async function createPage(parentId, title) {
  const body = { parent: { page_id: parentId }, properties: { title: [{ text: { content: truncate(title, 1900) } }] } };
  const r = await notion("POST", "/pages", body);
  return r.id;
}
async function appendBlocks(pageId, blocks) {
  for (let i = 0; i < blocks.length; i += 100)
    await notion("PATCH", `/blocks/${pageId}/children`, { children: blocks.slice(i, i + 100) });
}

// ---------- 主流程 ----------
async function main() {
  const docs = JSON.parse(fs.readFileSync(inFile, "utf8"));
  console.log(`加载 ${docs.length} 条记录`);

  // 根页面
  let rootId = CONFIG.rootPageId;
  if (!rootId) {
    if (state.rootPageId) rootId = state.rootPageId;
    else {
      const p = await notion("POST", "/pages", {
        parent: { type: "workspace", workspace: true },
        icon: { type: "emoji", emoji: "🗂️" },
        properties: { title: [{ text: { content: CONFIG.rootTitle } }] },
      });
      rootId = state.rootPageId = p.id; saveState();
    }
  }
  console.log(`根页面: ${rootId}`);

  // 按库分组 → 建库页 → 按 parentUuid 组树递归导入
  const books = new Map();
  for (const d of docs) {
    if (!books.has(d.bookNs)) books.set(d.bookNs, { name: d.bookName, items: [] });
    books.get(d.bookNs).items.push(d);
  }
  for (const [ns, book] of books) {
    let bookId = state.books?.[ns];
    if (!bookId) { bookId = await createPage(rootId, book.name); (state.books ??= {})[ns] = bookId; saveState(); }
    const uuidSet = new Set(book.items.map((d) => d.uuid));
    const byParent = new Map();
    for (const d of book.items) {
      const p = d.parentUuid && uuidSet.has(d.parentUuid) ? d.parentUuid : null;
      (byParent.get(p) ?? byParent.set(p, []).get(p)).push(d);
    }
    console.log(`▶ ${book.name} (${ns}) — ${book.items.length} 条`);
    let pages = 0, imgs = 0, errs = 0;
    async function walk(parentUuid, notionParent) {
      for (const d of byParent.get(parentUuid) || []) {
        const key = `${ns}|${d.uuid}`;
        let pid = state.pages?.[key];
        const done = !!state.done?.[key];
        if (!pid) {
          try { pid = await createPage(notionParent, d.title || "(无标题)"); }
          catch (e) { console.log(`  [page] ${key}: ${e.message}`); errs++; continue; }
          (state.pages ??= {})[key] = pid; saveState();
        }
        pages++;
        if (!done && d.type === "DOC") {
          try {
            let mdSrc = (d.md || "").slice(0, CONFIG.maxDocChars);
            if (!mdSrc.trim()) {
              await appendBlocks(pid, [{ object: "block", type: "paragraph",
                paragraph: { rich_text: [{ text: { content: "(源文档为空)" } }] } }]);
            } else {
              if (CONFIG.footer && d.slug)
                mdSrc += `\n\n---\n\n🔗 [原文](https://www.yuque.com/${/* 你的语雀用户名 */ "YOUR_YUQUE_USER"}/${ns}/${d.slug})` +
                  (d.createdAt ? ` · 创建 ${d.createdAt.slice(0, 10)}` : "") +
                  (d.updatedAt ? ` · 更新 ${d.updatedAt.slice(0, 10)}` : "");
              const blocks = flatten(markdownToBlocks(mdSrc));
              blocks.forEach(splitRichText);
              sanitizeLinks(blocks);
              imgs += await localizeImages(blocks);
              await appendBlocks(pid, blocks);
            }
            (state.done ??= {})[key] = true; saveState();
          } catch (e) { console.log(`  [content] ${key}: ${e.message}`); errs++; }
        } else if (!done && d.type === "TITLE") { (state.done ??= {})[key] = true; saveState(); }
        await walk(d.uuid, pid);
      }
    }
    await walk(null, bookId);
    console.log(`  ✔ ${pages} 页, ${imgs} 图, 错误 ${errs}`);
  }
  console.log("===== 导入完成 ====="); saveState();
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
