# 把这段提示词 + 脚本包直接喂给 AI（如 Claude/GPT/智能体工具），即可复刻整个迁移

---

你是一个熟练的自动化工程师。请帮我完成「语雀笔记全量迁移到 Notion」任务。我已提供脚本包（scripts/ 目录，按编号使用），请严格按以下流程执行，并注意每个步骤的坑位说明。

## 前置条件（需要我配合的部分）

1. 浏览器已登录语雀（www.yuque.com）——抓取阶段需要我的登录会话
2. Notion 个人访问令牌：在 notion.so/developers/tokens 创建（勾选 Notion API 能力），提供给你环境变量 `NOTION_TOKEN`
3. Notion 中任意一个目标父页面（或留空自动创建顶级页面）

## 执行流程

### 第 1 步：环境准备
- 本机需要 Node ≥ 20（`npm i @tryfabric/martian turndown`，npm registry 可设为 https://registry.npmmirror.com）
- ⚠️ 如果本机没有 Node 且 Homebrew 从 GitHub 拉包失败（网络受限），直接从 npmmirror 下载 Node 二进制包解压：
  `curl -L https://registry.npmmirror.com/-/binary/node/v22.14.0/node-v22.14.0-darwin-arm64.tar.gz`

### 第 2 步：抓取语雀（用我的登录会话）
- 如果你能控制浏览器（如浏览器自动化工具/插件），让我在浏览器里登录语雀后，你在页面上下文执行 `scripts/01_scrape.console.js` 的逻辑（fetch 带 credentials:include），分批把结果写到本地 `docs_raw.json`
- 如果我不能给你浏览器权限，把 01 脚本内容给我，我自己粘贴到 DevTools Console 运行，再把 `docs_raw.json` 交给你
- **关键坑**：语雀 `/markdown` 导出端点对大量文档只返回「导入数据处理」占位空页（HTTP 200 但内容是空壳），**必须**用 `/api/docs/{slug}?book_id={id}&format=lake` 详情接口的 `content` 字段（lake 格式）。开源的语雀导出工具大多踩这个坑。

### 第 3 步：转换为 Markdown
- 运行 `scripts/03_prepare.mjs docs_raw.json docs_final.json`
- lake 格式的图片/附件是 `<card name="image" value="data:URL编码JSON">` 语法，02 脚本负责解码；转换后要**还原 turndown 的转义**（`!\[` → `![`），否则图片语法失效

### 第 4 步：图片处理
- 用 03 产出的 `*.imgurls.txt` 作为图片清单
- `cdn.nlark.com` 的图可直接 curl 下载（公开、无需登录）；macOS 用 `sips` 把 HEIC 转 JPG（iPhone 照片，Notion 不支持 HEIC）
- **语雀附件图**（`www.yuque.com/attachments/...`，网页剪藏的图大多属于这类）需要登录态：
  1. 在登录会话内执行 `scripts/04_resolve_signed.console.js` 拿到 302 后的签名直链（有数小时有效期，解析完立刻下载）
  2. 下载后**按文件魔数识别真实格式**（它们全部以 octet-stream 存储，扩展名不可信）
- 运行 `scripts/05_download_images.py` 生成 `images/` 目录和 `image_map.json`（URL→本地文件映射）
- 有道云笔记迁移来的外链图（note.youdao.com）大多是死链，下载失败就保留原链接，不要卡住

### 第 5 步：导入 Notion
- 运行 `scripts/06_import_notion.mjs docs_final.json`（NOTION_TOKEN/ROOT_PAGE_ID 环境变量）
- 特性：按 TOC 树形层级建页、断点续传（import_state.json）、超 3rps 自动退避、60s 超时防挂死
- **必须处理的 Notion 校验规则**（不处理会随机 400）：
  1. martian 产出的子块挂在 `block[type].children`，quote/paragraph/heading 不允许有 children → 拍平
  2. Markdown 自动链接会产生非法 URL（含 `]`、中文、空格、>2000 字符）→ 用严格校验（ASCII 可打印 + new URL 可解析），不过关就删 link 保文字
  3. rich_text 单元素 2000 字符上限 → 切分
  4. 页面标题截断要按 Unicode 码点（切断 emoji 代理对会产生 "Error parsing JSON body"）
  5. 超长文档（1MB+ 网页剪藏）会让 marked 卡死 → 200KB 截断加提示
- **图片上传**：`POST /file_uploads` 创建 → `POST /file_uploads/{id}/send` 用 **multipart FormData**（file 字段，不是裸二进制）；file_upload 状态必须是 pending 才能 send；file_upload 接口配额独立于 3rps，可适度放宽提速

### 第 6 步：图片收尾修复（导入完必做）
- markdown 里「行内图片」会被降级成纯 URL 文本段或行内链接，导入后在 Notion 里显示为链接文字——这就是"图片全是链接"的根源
- 运行 `scripts/07_fix_images.mjs`：扫描全部页面，把纯 URL 文本段替换为原位图片块、行内链接去掉并插图、外链图片块转存
- 用 `after` 参数（PATCH /blocks/{page_id}/children）实现块后插入

### 第 7 步：验收
- 抽样打开若干页面确认：层级正确、图片显示为图片而非链接、每页底部有原文链接
- 统计报告：建页数 vs 源文档数、空文档数、失败清单

## 全局注意事项

- 语雀页内 fetch 的并发 ≤5、请求间隔 ≥60ms，避免触发风控；Notion 全局限速 3 rps（file_uploads 除外），429 按重试头退避
- 所有步骤幂等可断点续传，中断后重跑即可
- 不要把我的 token/账号信息写进任何文件或日志
- 遇到单篇文档反复失败：先本地复现转换结果二分定位坏块，通常是上面第 5 步的五条校验规则之一没覆盖

现在开始。先向我确认：Notion token 与目标页面是否已就绪、浏览器登录状态由谁提供（你自动化 or 我手动粘贴），然后按流程执行。
