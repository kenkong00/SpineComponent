# -*- coding: utf-8 -*-
"""直接调 Sam3Engine，看 predict / predict_boxed 原始返回的 score 分布。"""
import os, sys, time, json
sys.stdout.reconfigure(encoding="utf-8")

PHOTON = r"H:\【work】\photon Studio"
CUTTER = os.path.join(PHOTON, "tools", "spine-cutter")
sys.path.insert(0, CUTTER)

import numpy as np, cv2
from PIL import Image
from sam3_engine import Sam3Engine

IMG = sys.argv[1] if len(sys.argv) > 1 else r"H:\【work】\photon Studio\test\20260718_00233_.png"

t0 = time.time()
eng = Sam3Engine(device="cuda", resolution=1008, confidence_threshold=0.05, verbose=False)
print("模型加载 %.1fs device=%s" % (time.time() - t0, eng.device))

img = Image.open(IMG).convert("RGB")
W, H = img.size
print("image %dx%d" % (W, H))
eng.set_image(img)

def show(tag, res):
    print("--- %s: %d 个候选" % (tag, len(res)))
    for i, r in enumerate(sorted(res, key=lambda z: -z["score"])[:6]):
        m = np.asarray(r["mask"])
        ys, xs = m.nonzero()
        bb = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())] if len(xs) else None
        print("   #%-2d score=%.4f px=%-8d bbox=%s" % (i, r["score"], int(m.sum()), bb))

# 1) 纯文本
t = time.time()
show("text 'head'", eng.predict("head"))
print("   (耗时 %.2fs)" % (time.time() - t))
show("text 'person'", eng.predict("person"))

# 2) 框提示：用图中央一个大方框（人为构造，验证接口）
cx, cy = W / 2, H / 2
box = [cx - W * 0.25, cy - H * 0.35, cx + W * 0.25, cy + H * 0.35]
t = time.time()
show("boxed 'head' center", eng.predict_boxed("head", box))
print("   (耗时 %.2fs)" % (time.time() - t))
print("DONE")
