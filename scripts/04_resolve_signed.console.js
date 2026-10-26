// ============================================================
// 语雀附件签名直链解析（在已登录语雀的浏览器 Console 中粘贴运行）
// 背景：www.yuque.com/attachments/... 需要登录态，curl 直接下会 302 到登录页。
// 本脚本在页面会话内 fetch，读取重定向后的签名 URL（有数小时有效期，解析后尽快下载）。
// 用法：
//   1. 先把图片 URL 清单存为 window.__imgurls = ["https://...", ...]（或由 04 步骤生成的 txt 粘贴进来）
//   2. 粘贴运行本文件
//   3. 完成后：copy(JSON.stringify(window.__resolved)) 保存为 signed_urls.json
// ============================================================
(async () => {
  if (!window.__imgurls) { console.error("先设置 window.__imgurls = [...URL数组]"); return; }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__resolved = [];
  let idx = 0, ok = 0, fail = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= window.__imgurls.length) return;
      const u = window.__imgurls[i];
      try {
        const res = await fetch(u, {
          credentials: "include",
          headers: { Range: "bytes=0-1" },   // 只取 2 字节，只要重定向结果
        });
        if (res.url && !res.url.includes("/login") && res.ok) {
          window.__resolved.push({ orig: u, signed: res.url });
          ok++;
          try { res.body && res.body.cancel(); } catch {}
        } else fail++;
      } catch { fail++; }
      if ((ok + fail) % 100 === 0) console.log(`${ok + fail}/${window.__imgurls.length}（成功 ${ok}）`);
      await sleep(30);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker(), worker()]);
  console.log(`%c✅ 解析完成 ${ok}/${window.__imgurls.length}，失败 ${fail}。执行 copy(JSON.stringify(window.__resolved))`, "color:green;font-weight:bold");
})();
