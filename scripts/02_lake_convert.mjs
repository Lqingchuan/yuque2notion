// ============================================================
// 语雀 lake 格式 → Markdown 转换器
// 处理 <card> 卡片（图片/附件/书签/公式/代码块/画板占位）
// 依赖：npm i turndown
// ============================================================
import TurndownService from "turndown";

const td = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
});
td.remove(["script", "style", "noscript", "iframe", "form"]);

function decodeValue(v) {
  if (!v) return {};
  try {
    let s = v;
    if (s.startsWith("data:")) s = s.slice(5);
    return JSON.parse(decodeURIComponent(s));
  } catch { return {}; }
}

function cardToMarkdown(attrs, inner) {
  const get = (name) => (attrs.match(new RegExp(`${name}="([^"]*)"`)) || [])[1] || "";
  const name = get("name");
  const type = get("type");
  const value = decodeValue(get("value"));
  switch (name) {
    case "image": {
      const src = value.src || "";
      return src ? (type === "inline" ? `![图](${src})` : `\n\n![图](${src})\n\n`) : "";
    }
    case "localdoc":
    case "attachment": {
      const src = value.src || value.url || "";
      return src ? `[附件 ${value.name || ""}](${src})` : "[附件]";
    }
    case "bookmark": {
      const url = value.url || "";
      return url ? `[${value.title || url}](${url})` : "";
    }
    case "hr":
      return "\n\n---\n\n";
    case "math":
    case "latex": {
      const tex = value.latex || value.tex || value.content || "";
      return tex ? (type === "inline" ? `$${tex}$` : `\n\n$$\n${tex}\n$$\n\n`) : "";
    }
    case "codeblock":
    case "code": {
      const code = value.code || value.content || "";
      return code ? `\n\n\`\`\`${value.language || ""}\n${code}\n\`\`\`\n\n` : "";
    }
    case "mindmap":
    case "whiteboard":
    case "board":
    case "table":
    case "sheet":
      return `\n\n> [语雀特有卡片：${name}，Notion 不支持，请回原文查看]\n\n`;
    default: {
      const text = (inner || "").replace(/<[^>]+>/g, " ").trim();
      return text ? `[${text}]` : `[卡片:${name}]`;
    }
  }
}

export function lakeToMarkdown(content) {
  if (!content) return "";
  let text = content
    .replace(/<card\b([^>]*)>([\s\S]*?)<\/card>/g, (_, a, i) => cardToMarkdown(a, i))
    .replace(/<card\b([^>]*?)\/?>/g, (_, a) => cardToMarkdown(a, ""))
    .replace(/<\/card>/g, "");
  let md;
  try { md = td.turndown(text); }
  catch { md = text.replace(/<[^>]+>/g, " "); }
  if (!md) return "";
  // 还原 turndown 对 Markdown 语法字符的转义（代码块内不动），否则图片语法失效
  return md
    .split(/(```[\s\S]*?```)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(/\\([[\]()!*_~`#>.|-])/g, "$1")))
    .join("");
}

// 命令行自测：node lake_convert.mjs
if (process.argv[1]?.endsWith("02_lake_convert.mjs")) {
  console.log(lakeToMarkdown(
    `<h1>标题</h1><p>正文<strong>加粗</strong></p>` +
    `<card type="block" name="image" value="data:%7B%22src%22%3A%22https%3A%2F%2Fcdn.nlark.com%2Ftest.png%22%7D"></card>`
  ));
}
