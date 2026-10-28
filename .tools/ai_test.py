# -*- coding: utf-8 -*-
"""AI 切分实测：发一张真实人像到 5311，把返回的蒙版叠加可视化，输出统计。"""
import base64, json, os, sys, time, urllib.request

os.environ["no_proxy"] = "127.0.0.1,localhost"
os.environ["NO_PROXY"] = "127.0.0.1,localhost"
sys.stdout.reconfigure(encoding="utf-8")

IMG = sys.argv[1] if len(sys.argv) > 1 else r"H:\【work】\photon Studio\test\20260718_00233_.png"
OUT = sys.argv[2] if len(sys.argv) > 2 else r"I:\TREA work\window操作界面\spine人物换装识别系统\.shots\ai_test"

raw = open(IMG, "rb").read()
b64 = base64.b64encode(raw).decode("ascii")
print("图片:", IMG, len(raw) // 1024, "KB")

req = urllib.request.Request(
    "http://127.0.0.1:5311/segment",
    data=json.dumps({"image": b64, "threshold": 0.35, "useBox": True}).encode(),
    headers={"Content-Type": "application/json"}, method="POST")
t0 = time.time()
with urllib.request.urlopen(req, timeout=600) as r:
    d = json.loads(r.read().decode("utf-8"))
print("推理耗时 %.2fs  device=%s  hasPose=%s  size=%s" % (
    time.time() - t0, d.get("device"), d.get("hasPose"), d.get("size")))

if not d.get("ok"):
    print("失败:", d.get("error"))
    sys.exit(1)

import numpy as np, cv2, os
os.makedirs(OUT, exist_ok=True)
img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
H, W = img.shape[:2]

color_map = [(230,80,80),(80,180,80),(80,80,230),(230,180,40),(160,60,200),
             (60,200,200),(230,120,60),(120,140,60),(200,60,160),(60,120,230),
             (90,220,90),(230,230,80),(120,60,230),(230,90,170),(80,200,230),(60,60,60)]
overlay = img.copy()
order = sorted([p for p in d["parts"] if p.get("ok")], key=lambda p: -p["pixels"])
print("%-12s %-6s %-8s %-9s %s" % ("name","score","pixels","bbox","boxUsed"))
def imwrite_u(path, img):
    """cv2.imwrite 不支持中文路径，用 imencode+tofile 兜底"""
    import cv2 as _cv
    ext = os.path.splitext(path)[1]
    ok, buf = _cv.imencode(ext, img)
    if ok:
        buf.tofile(path)
    return ok

for i, p in enumerate(order):
    m = cv2.imdecode(np.frombuffer(base64.b64decode(p["mask"]), np.uint8), cv2.IMREAD_GRAYSCALE)
    c = color_map[i % len(color_map)]
    ov = np.zeros_like(img); ov[m > 127] = c
    overlay = cv2.addWeighted(overlay, 1.0, ov, 0.45, 0)
    print("%-12s %-6.3f %-8d %-9s %s" % (p["name"], p["score"], p["pixels"],
          str(p["bbox"]), "Y" if p.get("boxUsed") else "-"))
    imwrite_u(os.path.join(OUT, "mask_%s.png" % p["name"]), m)
failed = [p["name"] for p in d["parts"] if not p.get("ok")]
print("未检出:", failed or "无")
imwrite_u(os.path.join(OUT, "overlay.png"), overlay)
print("可视化 ->", os.path.join(OUT, "overlay.png"))
