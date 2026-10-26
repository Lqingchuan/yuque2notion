// ============================================================
// 语雀全量抓取脚本（在已登录语雀的浏览器 DevTools Console 中粘贴运行）
// 用法：
//   1. 浏览器打开 https://www.yuque.com/dashboard
//   2. F12 打开控制台，粘贴本文件全部内容，回车
//   3. 等待进度输出（2000 篇约 15~30 分钟，可切走干别的）
//   4. 结束后执行：copy(JSON.stringify(window.__scrape.result))
//      剪贴板里就是完整 JSON，保存为 docs_raw.json
// ============================================================
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 1) 拉取全部知识库
  const books = [];
  for (let offset = 0; offset < 1000; offset += 30) {
    const res = await fetch(`/api/mine/books?type=Book&offset=${offset}&limit=30`, {
      headers: { accept: "application/json" }, credentials: "include",
    });
    const j = await res.json();
    const arr = j.data || [];
    books.push(...arr.map((b) => ({ id: b.id, ns: b.slug, name: b.name, items: b.items_count })));
    if (arr.length < 30) break;
    await sleep(150);
  }
  console.log(`共 ${books.length} 个知识库`);

  // 2) 拉取每个库的目录（TOC 含树形层级 parent_uuid）
  const result = [];
  let bookDone = 0;
  for (const b of books) {
    try {
      const res = await fetch(`/api/books/${b.id}/toc`, {
        headers: { accept: "application/json" }, credentials: "include",
      });
      const j = await res.json();
      const toc = (j.data && j.data.toc) || [];
      for (const t of toc) {
        result.push({
          bookId: b.id, bookNs: b.ns, bookName: b.name,
          uuid: t.uuid, parentUuid: t.parent_uuid,
          type: t.type,            // DOC = 文档, TITLE = 分组标题
          title: t.title, slug: t.type === "DOC" ? t.url : null,
        });
      }
    } catch (e) { console.warn(`TOC失败 ${b.ns}`, e); }
    bookDone++;
    if (bookDone % 5 === 0) console.log(`目录 ${bookDone}/${books.length}`);
    await sleep(120);
  }
  const docCount = result.filter((x) => x.type === "DOC").length;
  console.log(`目录完成，共 ${result.length} 条（文档 ${docCount} 篇），开始抓正文…`);

  // 3) 抓正文：详情接口（lake 格式）。
  //    ⚠️ 不要用 /markdown 导出端点：对大量文档它只返回"导入数据处理"占位空页
  const queue = result.filter((x) => x.type === "DOC" && x.slug);
  let idx = 0, ok = 0, fail = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= queue.length) return;
      const item = queue[i];
      try {
        const res = await fetch(`/api/docs/${item.slug}?book_id=${item.bookId}&format=lake`, {
          headers: { accept: "application/json" }, credentials: "include",
        });
        const j = await res.json();
        const d = j.data || {};
        item.content = d.content || "";      // lake 格式正文（HTML + card）
        item.format = d.format || null;
        item.wordCount = d.word_count;
        item.createdAt = d.created_at;
        item.updatedAt = d.updated_at;
        ok++;
      } catch (e) {
        item.content = ""; item.error = String(e).slice(0, 100);
        fail++;
      }
      if ((ok + fail) % 50 === 0)
        console.log(`正文 ${(ok + fail)}/${queue.length}（成功 ${ok} 失败 ${fail}）`);
      await sleep(60 + Math.random() * 60);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);

  window.__scrape = { result, docCount, fail };
  console.log(`%c✅ 全部完成！成功 ${ok}，失败 ${fail}。`, "color:green;font-weight:bold");
  console.log(`下一步执行 copy(JSON.stringify(window.__scrape.result)) 并保存为 docs_raw.json`);
})();
