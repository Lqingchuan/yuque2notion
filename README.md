# yuque2notion · 语雀笔记全量迁移到 Notion

> 2000+ 篇文档、6400+ 张图片、完整层级还原，全程可断点续传。
> 本项目由 AI 智能体（ZCode）端到端完成开发与执行，实战验证 2053 篇笔记迁移成功。

## 为什么不用现成工具？

| 方案 | 问题 |
|---|---|
| 语雀官方"导出" | 逐库手动，且很多账号**整库导出被限制** |
| 官方 `/markdown` 导出端点 | ⚠️ **对大量文档只返回"导入数据处理"占位空页**（HTTP 200、内容为空壳），本账号 70% 文档中招 |
| yuque-dl 等开源下载器 | 走的正是上述占位端点，拿到的是空文档 |
| Notion 官方导入 | 不支持语雀格式；手动拖 zip 对大库容易失败且不可断点 |

**解法**：改用语雀文档详情接口 `/api/docs/{slug}?book_id={id}&format=lake` 取 `content` 字段（lake 格式），自己完成 lake → Markdown → Notion Block 的转换。

## 流程总览

```
[浏览器登录会话]                [本地脚本]                       [Notion API]
01 抓取 TOC+正文(lake)    →    03 lake→Markdown 清洗合并   →    06 导入（层级+断点）
04 附件签名直链解析        →    05 图片下载+格式识别+映射        07 图片收尾修复
```

## 使用

前置：Node ≥ 20、Python 3、语雀网页已登录、Notion 个人访问令牌（notion.so/developers/tokens）。

```bash
npm i @tryfabric/martian turndown

# 1. 在已登录语雀的浏览器 Console 运行 scripts/01_scrape.console.js
#    结束后 copy(JSON.stringify(window.__scrape.result)) 存为 docs_raw.json
# 2. 清洗转换
node scripts/03_prepare.mjs docs_raw.json docs_final.json
# 3. 下载图片（附件需先在 Console 跑 04 解析签名直链，得到 signed_urls.json）
python3 scripts/05_download_images.py docs_final.imgurls.txt signed_urls.json
# 4. 导入
export NOTION_TOKEN="ntn_xxx"
node scripts/06_import_notion.mjs docs_final.json
# 5. 图片收尾修复（把降级成链接的图片替换为真图片块）
node scripts/07_fix_images.mjs docs_final.json
```

**或者更省事**：把 [PROMPT-FOR-AI.md](PROMPT-FOR-AI.md) + 本仓库直接喂给 AI 编程助手，它会带着你走完全程（提示词里包含全部踩坑细节）。

## 脚本清单

| 文件 | 运行位置 | 作用 |
|---|---|---|
| `01_scrape.console.js` | 语雀页面 DevTools Console | 抓全部知识库目录+正文（lake 格式），绕过坏掉的导出端点 |
| `02_lake_convert.mjs` | 本地 | lake `<card>` 卡片 → Markdown（图片/附件/公式/代码块/画板占位） |
| `03_prepare.mjs` | 本地 | 清洗合并、去重、去除 data:URI 装饰图、导出图片 URL 清单 |
| `04_resolve_signed.console.js` | 语雀页面 Console | 解析附件图的登录态签名直链（数小时有效） |
| `05_download_images.py` | 本地 | 并发下载全部图片，按文件魔数识别格式（语雀附件都是 octet-stream），生成 URL→文件映射 |
| `06_import_notion.mjs` | 本地 | Notion 导入主程序：层级还原、断点续传、3rps 限速、非法 URL 清洗、超长截断、图片上传 |
| `07_fix_images.mjs` | 本地 | 图片收尾：URL 文本段→图片块、行内链接→去链插图、外链块→转存 |

## 实战踩坑（详情见 PROMPT-FOR-AI.md）

1. 语雀导出端点返回空页 → 用详情接口 `format=lake`
2. 语雀附件需登录态且是 octet-stream → 页面会话解析签名直链 + 文件魔数识别格式
3. iPhone 的 HEIC 图 Notion 不支持 → sips 转 JPG
4. martian 子块结构陷阱（`block[type].children`）、非法自动链接、2000 字符限制、emoji 代理对截断
5. Notion file_uploads 必须用 multipart FormData，且状态为 pending
6. 行内图片会被 markdown 解析降级为链接 → 导入后需二次修复（07）

## 迁移效果

- 知识库 → Notion 顶级页面下的同名页面，TOC 树形层级完整还原
- 图片全部转为 Notion 托管文件（不再依赖语雀 CDN 与登录态）
- 每篇文档底部附原文链接与创建/更新日期
- 实测：2053 篇、36 个知识库、约 4900 个图片块，全程无人值守

## License

MIT
