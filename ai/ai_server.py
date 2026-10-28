#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
AI 智能切分服务（常驻进程，端口 5311）

为什么是常驻进程：SAM 3.1 权重 1.7GB，加载要 20~60 秒。
如果像普通脚本那样「每次切分都重启一次 Python」，用户每点一次按钮都要等一分钟。
所以这里起一个常驻 HTTP 服务，模型只加载一次，之后每次切分只要 1~3 秒。

模型分工：
  YOLOv8n-pose  ->  人体 17 关键点（快，<1s），用来推导每个部件的大致位置
  SAM 3.1       ->  按「文本提示 + 几何框提示」精确抠出部件蒙版

为什么必须给框：纯文本 "hand" 只会返回画面里最显著的那一只手，左右分不清，
而且容易把整条胳膊都框进来。给了框，SAM3 就只在框内找该语义的东西。

对外接口：
  GET  /health    -> {"status":"loading|ready|error", "msg":..., "device":...}
  POST /segment   -> 见 segment() 文档
  POST /shutdown  -> 关闭服务

依赖全部来自 Photon Studio 的 .venv（torch / ultralytics / sam3 / cv2），
本文件只用标准库，不额外装包。
"""
import argparse
import base64
import json
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = {
    "status": "loading",   # loading / ready / error
    "msg": "正在启动...",
    "device": None,
    "engine": None,        # Sam3Engine
    "pose": None,          # ultralytics YOLO
    "err": None,
    "load_t": 0.0,
}

# ---------------------------------------------------------------- 部件定义
# key: 部件 id（同时作为默认导出名）
# cn : 中文显示名
# prompts: SAM3 英文提示词，按顺序尝试，取分数最高的
# box: 如何从关键点推导几何框 —— ("seg", A, B) 两点胶囊; ("pt", P, 半径系数)
PART_DEFS = [
    # ---- 头部 ----
    dict(key="hair",   cn="头发",   prompts=["hair", "human hair"],
         box=("box_hair",)),
    dict(key="head",   cn="头部",   prompts=["head", "human head", "face"],
         box=("seg", "nose", "nose", 0.10), point="nose", span=("L_ear", "R_ear", "L_eye", "R_eye")),
    # ---- 躯干 ----
    dict(key="torso",  cn="躯干",   prompts=["torso", "upper body", "chest"],
         box=("span", "L_shoulder", "R_shoulder", "L_hip", "R_hip"), point=None),
    # ---- 上肢 ----
    dict(key="arm_l",  cn="左臂上", prompts=["left upper arm", "upper arm", "arm"],
         box=("seg", "L_shoulder", "L_elbow", 0.055)),
    dict(key="forearm_l", cn="左小臂", prompts=["left forearm", "forearm", "arm"],
         box=("seg", "L_elbow", "L_wrist", 0.05)),
    dict(key="hand_l", cn="左手",   prompts=["left hand", "hand"],
         box=("pt", "L_wrist", 0.075), point="L_wrist"),
    dict(key="arm_r",  cn="右臂上", prompts=["right upper arm", "upper arm", "arm"],
         box=("seg", "R_shoulder", "R_elbow", 0.055)),
    dict(key="forearm_r", cn="右小臂", prompts=["right forearm", "forearm", "arm"],
         box=("seg", "R_elbow", "R_wrist", 0.05)),
    dict(key="hand_r", cn="右手",   prompts=["right hand", "hand"],
         box=("pt", "R_wrist", 0.075), point="R_wrist"),
    # ---- 下肢 ----
    dict(key="thigh_l", cn="左大腿", prompts=["left thigh", "upper leg", "leg"],
         box=("seg", "L_hip", "L_knee", 0.075)),
    dict(key="shin_l",  cn="左小腿", prompts=["left lower leg", "shin", "leg"],
         box=("seg", "L_knee", "L_ankle", 0.06)),
    dict(key="foot_l",  cn="左脚",   prompts=["left foot", "foot", "shoe"],
         box=("pt", "L_ankle", 0.075), point="L_ankle"),
    dict(key="thigh_r", cn="右大腿", prompts=["right thigh", "upper leg", "leg"],
         box=("seg", "R_hip", "R_knee", 0.075)),
    dict(key="shin_r",  cn="右小腿", prompts=["right lower leg", "shin", "leg"],
         box=("seg", "R_knee", "R_ankle", 0.06)),
    dict(key="foot_r",  cn="右脚",   prompts=["right foot", "foot", "shoe"],
         box=("pt", "R_ankle", 0.075), point="R_ankle"),
]

# 服装类（不靠关键点，纯文本 + 人体框）
CLOTH_DEFS = [
    dict(key="cloth_top",  cn="上衣", prompts=["shirt", "jacket", "upper garment", "clothes"]),
    dict(key="cloth_bot",  cn="下装", prompts=["pants", "trousers", "skirt", "lower garment"]),
    dict(key="shoes",      cn="鞋子", prompts=["shoes", "boots", "footwear"]),
    dict(key="hat",        cn="帽子", prompts=["hat", "cap", "headwear"]),
]


def _kp(kps, name):
    v = kps.get(name)
    if not v:
        return None
    return (float(v[0]), float(v[1]))


def derive_box(defn, kps, W, H):
    """按关键点推导部件几何框 [x0,y0,x1,y1]（原图像素坐标）。"""
    spec = defn.get("box")
    if not spec:
        return None
    kind = spec[0]
    base = max(W, H)

    if kind == "seg":
        _, a, b, rad = spec
        pa, pb = _kp(kps, a), _kp(kps, b)
        if not pa or not pb:
            return None
        r = base * rad
        x0 = min(pa[0], pb[0]) - r
        x1 = max(pa[0], pb[0]) + r
        y0 = min(pa[1], pb[1]) - r
        y1 = max(pa[1], pb[1]) + r
        return [x0, y0, x1, y1]

    if kind == "pt":
        _, a, rad = spec
        p = _kp(kps, a)
        if not p:
            return None
        r = base * rad
        return [p[0] - r, p[1] - r, p[0] + r, p[1] + r]

    if kind == "span":
        # 多个关键点的包围盒，再外扩一点
        pts = [_kp(kps, n) for n in spec[1:]]
        pts = [p for p in pts if p]
        if not pts:
            return None
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        mx = (max(xs) - min(xs)) * 0.18
        my = (max(ys) - min(ys)) * 0.12
        return [min(xs) - mx, min(ys) - my, max(xs) + mx, max(ys) + my]

    if kind == "box_hair":
        # 头发：以鼻子为基准往上、往外扩一片
        p = _kp(kps, "nose")
        if not p:
            return None
        r = base * 0.16
        return [p[0] - r * 1.15, p[1] - r * 2.0, p[0] + r * 1.15, p[1] + r * 0.45]
    return None


def clamp_box(box, W, H):
    if not box:
        return None
    x0, y0, x1, y1 = box
    return [max(0.0, x0), max(0.0, y0), min(float(W), x1), min(float(H), y1)]


# ---------------------------------------------------------------- 模型加载
def load_models(cfg):
    t0 = time.time()
    try:
        photon = cfg["photonRoot"]
        cutter = os.path.join(photon, cfg.get("spineCutter", "tools/spine-cutter"))
        if not os.path.isdir(cutter):
            raise RuntimeError("找不到 Photon Studio 的 spine-cutter 目录: %s" % cutter)
        if cutter not in sys.path:
            sys.path.insert(0, cutter)

        device = cfg.get("device") or ("cuda" if _torch().cuda.is_available() else "cpu")

        # --- 1) YOLOv8-pose（轻，先加载）---
        STATE["msg"] = "加载 YOLOv8-pose 关键点模型..."
        from ultralytics import YOLO
        pm = cfg.get("poseModel", "models/yolov8n-pose.pt")
        pm_path = pm if os.path.isabs(pm) else os.path.join(photon, pm)
        if not os.path.exists(pm_path):
            raise RuntimeError("找不到 pose 模型: %s" % pm_path)
        STATE["pose"] = YOLO(pm_path)
        STATE["msg"] = "YOLO 就绪"

        # --- 2) SAM 3.1（重）---
        STATE["msg"] = "加载 SAM 3.1 权重（1.7GB，首次约 20~60 秒）..."
        from sam3_engine import Sam3Engine
        sc = cfg.get("samCkpt", "models/sam/sam3.1_multiplex_fp16.safetensors")
        sc_path = sc if os.path.isabs(sc) else os.path.join(photon, sc)
        if not os.path.exists(sc_path):
            raise RuntimeError("找不到 SAM3 权重: %s" % sc_path)
        STATE["engine"] = Sam3Engine(
            ckpt_path=sc_path,
            device=device,
            resolution=int(cfg.get("resolution", 1008)),
            confidence_threshold=float(cfg.get("threshold", 0.4)),
        )
        STATE["device"] = device
        STATE["status"] = "ready"
        STATE["msg"] = "就绪"
        STATE["load_t"] = time.time() - t0
        print("[ai] 模型就绪 device=%s 耗时 %.1fs" % (device, STATE["load_t"]), flush=True)
    except Exception as e:
        STATE["status"] = "error"
        STATE["err"] = "%s: %s" % (type(e).__name__, e)
        STATE["msg"] = "加载失败：" + STATE["err"]
        traceback.print_exc()
        print("[ai] ERROR " + STATE["err"], flush=True)


def _torch():
    import torch
    return torch


# ---------------------------------------------------------------- 推理
def run_pose(img_bgr):
    """返回 (keypoints dict or None, person box or None)"""
    if STATE["pose"] is None:
        return None, None
    res = STATE["pose"](img_bgr, conf=0.25, device=STATE["device"] or "cpu", verbose=False)
    names = ["nose", "L_eye", "R_eye", "L_ear", "R_ear",
             "L_shoulder", "R_shoulder", "L_elbow", "R_elbow",
             "L_wrist", "R_wrist", "L_hip", "R_hip",
             "L_knee", "R_knee", "L_ankle", "R_ankle"]
    best, best_area, best_box = None, -1, None
    for r in res:
        if r.keypoints is None:
            continue
        xy = r.keypoints.xy.cpu().numpy()
        conf = r.keypoints.conf.cpu().numpy() if r.keypoints.conf is not None else None
        boxes = r.boxes.xyxy.cpu().numpy() if r.boxes is not None else []
        for i in range(len(xy)):
            kps, cf = {}, {}
            for j, n in enumerate(names):
                kps[n] = [float(xy[i][j][0]), float(xy[i][j][1])]
                cf[n] = float(conf[i][j]) if conf is not None else 1.0
            bx = [float(v) for v in boxes[i]] if len(boxes) else None
            a = (bx[2] - bx[0]) * (bx[3] - bx[1]) if bx else 0
            if a > best_area:
                best, best_area, best_box = (kps, cf), a, bx
    # 注意：best 是 (kps_dict, conf_dict) 元组，必须拆开，否则上游拿 tuple 去 .get 会炸
    return (best[0] if best else None), (best[1] if best else None), best_box


def mask_to_png_b64(mask_u8):
    import cv2
    ok, buf = cv2.imencode(".png", mask_u8)
    if not ok:
        raise RuntimeError("mask 编码失败")
    return base64.b64encode(buf.tobytes()).decode("ascii")


def do_segment(payload):
    """payload: {image: <base64 png/jpg> or dataURL, parts: [key...], threshold, useBox}"""
    import cv2
    import numpy as np
    from PIL import Image

    if STATE["status"] != "ready":
        return {"ok": False, "error": "模型未就绪：" + str(STATE["msg"])}

    t0 = time.time()
    raw = payload.get("image") or ""
    if "," in raw[:64]:
        raw = raw.split(",", 1)[1]
    data = base64.b64decode(raw)
    arr = np.frombuffer(data, np.uint8)
    img_bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img_bgr is None:
        return {"ok": False, "error": "无法解码图片"}
    H, W = img_bgr.shape[:2]
    img_rgb = Image.fromarray(cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)).convert("RGB")

    eng = STATE["engine"]
    thr = float(payload.get("threshold", 0.35))
    use_box = bool(payload.get("useBox", True))

    # 1) 姿态关键点
    kps, kconf, person_box = run_pose(img_bgr)
    eng.set_image(img_rgb)

    want = payload.get("parts") or [d["key"] for d in PART_DEFS]
    want = [str(w) for w in want]
    defs = PART_DEFS + CLOTH_DEFS
    by_key = {d["key"]: d for d in defs}

    out_parts = []
    for key in want:
        d = by_key.get(key)
        if d is None:
            # 自定义提示词：直接当 prompt 用
            d = dict(key=key, cn=key, prompts=[key], box=None)

        best = None
        box_used = None
        for prompt in d.get("prompts", [key]):
            try:
                if use_box and kps and d.get("box"):
                    bx = clamp_box(derive_box(d, kps, W, H), W, H)
                    if bx is None or (bx[2] - bx[0]) < 2 or (bx[3] - bx[1]) < 2:
                        continue
                    pt = _kp(kps, d["point"]) if d.get("point") else None
                    res = eng.predict_boxed(prompt, bx, point_xy=pt)
                    box_used = bx
                else:
                    res = eng.predict(prompt)
            except Exception as e:
                print("[ai] prompt '%s' 失败: %s: %s" % (prompt, type(e).__name__, e), flush=True)
                continue
            for r in res:
                if r["score"] < thr:
                    continue
                if best is None or r["score"] > best["score"]:
                    best = dict(r, used_prompt=prompt)

        if best is None:
            out_parts.append({"name": key, "cn": d.get("cn", key), "ok": False,
                              "score": 0.0, "reason": "未检出"})
            continue

        m = np.asarray(best["mask"])
        if m.shape[0] != H or m.shape[1] != W:
            m = cv2.resize(m.astype(np.uint8), (W, H), interpolation=cv2.INTER_NEAREST) > 0.5
        m = m.astype(bool)
        if m.sum() < 8:
            out_parts.append({"name": key, "cn": d.get("cn", key), "ok": False,
                              "score": float(best["score"]), "reason": "蒙版过小"})
            continue

        ys, xs = m.nonzero()
        out_parts.append({
            "name": key,
            "cn": d.get("cn", key),
            "ok": True,
            "score": round(float(best["score"]), 4),
            "prompt": best.get("used_prompt"),
            "bbox": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1],
            "pixels": int(m.sum()),
            "boxUsed": [int(v) for v in box_used] if box_used else None,
            "mask": mask_to_png_b64((m.astype(np.uint8)) * 255),
        })

    return {
        "ok": True,
        "size": [W, H],
        "device": STATE["device"],
        "elapsed": round(time.time() - t0, 2),
        "hasPose": kps is not None,
        "keypoints": kps,
        "keypointConf": kconf,
        "personBox": [int(v) for v in person_box] if person_box else None,
        "parts": out_parts,
    }


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(b)
        except Exception:
            pass

    def log_message(self, fmt, *args):
        pass  # 静音，避免刷屏

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send(200, {
                "status": STATE["status"],
                "msg": STATE["msg"],
                "err": STATE["err"],
                "device": STATE["device"],
                "loadSeconds": round(STATE["load_t"], 1),
            })
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n) if n else b"{}"
            payload = json.loads(body.decode("utf-8"))
        except Exception as e:
            self._send(400, {"ok": False, "error": "请求体解析失败: %s" % e})
            return

        try:
            if self.path.startswith("/segment"):
                self._send(200, do_segment(payload))
            elif self.path.startswith("/shutdown"):
                self._send(200, {"ok": True})
                threading.Thread(target=_shutdown, daemon=True).start()
            else:
                self._send(404, {"ok": False, "error": "not found"})
        except Exception as e:
            traceback.print_exc()
            self._send(500, {"ok": False, "error": "%s: %s" % (type(e).__name__, e)})


def _shutdown():
    time.sleep(0.4)
    os._exit(0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--port", type=int, default=None)
    args = ap.parse_args()

    with open(args.config, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    port = args.port or int(cfg.get("port", 5311))

    threading.Thread(target=load_models, args=(cfg,), daemon=True).start()

    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("[ai] 服务已启动 http://127.0.0.1:%d" % port, flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
