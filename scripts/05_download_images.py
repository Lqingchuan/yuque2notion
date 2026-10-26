#!/usr/bin/env python3
"""
下载全部图片并构建 URL → 本地文件映射。
- 公网 CDN 图（如 cdn.nlark.com）：直接下载
- 语雀附件：用 04 解析出的签名直链下载（orig URL 的 sha1 前 40 位作文件名）
- 按文件魔数识别真实格式（语雀附件都是 octet-stream，别信扩展名）
用法：
  python3 05_download_images.py docs_final.imgurls.txt [signed_urls.json]
输出：
  images/           全部图片文件
  image_map.json    {"原始URL": {"file": "xxx.png"}}
"""
import hashlib, json, mimetypes, os, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
import urllib.request

OUT = "images"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
HASH_EXT = {}  # populated below

def sha(u): return hashlib.sha1(u.encode()).hexdigest()[:40]

def sniff(path):
    """用 file 命令识别真实 MIME（macOS/Linux 自带）"""
    try:
        out = subprocess.run(["file", "-b", "--mime-type", path],
                             capture_output=True, text=True, timeout=10).stdout.strip()
        return out
    except Exception:
        return None

def download(task):
    url, signed = task
    h = sha(url)
    for ext in ("jpg","png","jpeg","gif","webp","bmp","svg","bin"):
        p = os.path.join(OUT, f"{h}.{ext}")
        if os.path.exists(p) and os.path.getsize(p) > 0:
            return url, p, True
    tmp = os.path.join(OUT, f"{h}.tmp")
    req = urllib.request.Request(signed, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
            f.write(r.read(50 * 1024 * 1024 + 1))
    except Exception as e:
        if os.path.exists(tmp): os.remove(tmp)
        return url, None, False
    mime = sniff(tmp) or ""
    if not mime.startswith("image/"):
        os.remove(tmp)
        return url, None, False
    ext = mime.split("/", 1)[1]
    ext = {"jpeg": "jpg", "svg+xml": "svg"}.get(ext, ext)
    if ext not in ("jpg","png","gif","webp","bmp","svg"): os.remove(tmp); return url, None, False
    final = os.path.join(OUT, f"{h}.{ext}")
    os.rename(tmp, final)
    return url, final, True

def main():
    urls_file = sys.argv[1]
    signed_file = sys.argv[2] if len(sys.argv) > 2 else None
    os.makedirs(OUT, exist_ok=True)
    urls = [u.strip() for u in open(urls_file) if u.strip()]
    # 语雀附件用签名直链，公网图直接下
    signed = {}
    if signed_file and os.path.exists(signed_file):
        for pair in json.load(open(signed_file)):
            signed[pair["orig"]] = pair["signed"]
    tasks = [(u, signed.get(u, u)) for u in urls]
    print(f"待下载 {len(tasks)}（其中 {sum(1 for u in urls if u in signed)} 个附件用签名直链）")
    mapping, missing = {}, []
    with ThreadPoolExecutor(max_workers=8) as ex:
        for i, (url, path, ok) in enumerate(ex.map(download, tasks)):
            if ok: mapping[url] = {"file": os.path.basename(path)}
            else: missing.append(url)
            if (i + 1) % 200 == 0: print(f"  {i+1}/{len(tasks)}")
    json.dump(mapping, open("image_map.json", "w"), ensure_ascii=False)
    open("image_missing.txt", "w").write("\n".join(missing))
    print(f"成功 {len(mapping)}，失败 {len(missing)} → image_map.json / image_missing.txt")

if __name__ == "__main__":
    main()
