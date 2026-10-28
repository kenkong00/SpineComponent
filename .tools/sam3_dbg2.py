# -*- coding: utf-8 -*-
import os, sys, time
sys.stdout.reconfigure(encoding="utf-8")
PHOTON = r"H:/【work】/photon Studio"
sys.path.insert(0, os.path.join(PHOTON, "tools", "spine-cutter"))
import numpy as np
from PIL import Image
from sam3_engine import Sam3Engine

eng = Sam3Engine(device="cuda", resolution=1008, confidence_threshold=0.05, verbose=False)
img = Image.open(r"H:/【work】/photon Studio/test/20260718_00233_.png").convert("RGB")
W, H = img.size
eng.set_image(img)
print("set_image 完成（未跑过任何纯文本 predict）")
try:
    res = eng.predict_boxed("head", [W*0.4, 0, W*0.6, H*0.3])
    print("直接 predict_boxed: %d 个候选" % len(res))
    for r in sorted(res, key=lambda z:-z["score"])[:3]:
        print("   score=%.3f" % r["score"])
except Exception as e:
    import traceback; traceback.print_exc()
