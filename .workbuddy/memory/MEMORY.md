# 项目长期备忘 · spine人物换装识别系统

## 这是什么
把 Spine（PhotoshopToSpine）导出的**源 JSON + images 散图**在网页还原成人物，
让每个部件独立可点选、可替换成用户自己的 PNG；另外用官方 Spine 3.8 运行时播放 `export*/` 里的动作。

## 硬性约定
- **端口 5310**，零依赖 Node（`http` + `fs`），**不要引入 npm 依赖**。
- 前端**无构建步骤**（纯 `<script>` 全局变量：`window.U / API / R / Compose / Anim / Parts / App`）。
  改完直接刷新即可，不需要 npm run build。
- `spine/` 是用户的原始素材，**只读**，不要改动里面任何文件。
- 写 `.bat` 必须 **GBK + CRLF 且不加 chcp**（见用户级记忆）。
- 给用户看的验证要给**实测数值/截图**，不要写"应该没问题"。

## 关键文件
- `launcher.js` — **唯一启动入口**（启动.bat 调它）：探测 `/api/ping` 判断端口归属；已运行→开浏览器复用；`--restart` 杀旧起新（taskkill→PowerShell 兜底+二次探测）；`--status`/`--port=N`。**给服务加任何"杀进程/重启"逻辑必须走 ping 签名 `spine-assembly-workshop`，不许按端口盲杀**
- `server.js` — 静态托管 + API：`/api/ping`、`/api/characters`、`/api/character/:id`、`/api/parts*`、`/api/outfits*`、`/api/skinmodels`、`/api/skinmodel?id=`、`/api/skin/merge`、`/api/skinmix*`
  - `parseCharacter()` 是核心：读源 JSON → 输出部件表（x/y/w/h/bone/active/variant/imgUrl/naturalW）
  - **`active` 规则**：slot 声明了 `attachment` 才是默认显示；没声明的算「备用/变体」必须 `visible:false`
- `public/js/skin.js` — **切换演示**（window.Skin）：皮肤型源 JSON 的「部位 × 皮肤」矩阵，逐部位混搭。
  - 服务端 `isSkinSourceJson()`：不是导出版 + `skins` 是对象 + **(皮肤数>1 或没有 default)** → 皮肤型模型。
  - `buildDeepImageIndex()` 按「末尾 1~3 段路径」建索引 + `resolveSkinImage()`（精确路径→`皮肤名/文件名`→同名文件），
    所以附件名 `"02/head"` 不管 images 目录叫什么都能命中。
  - **bbox 取所有皮肤所有部位的并集**（切换皮肤时画面不跳）。
  - `POST /api/skin/merge`：把逐部位选择合成**一个新 skin** 写进 JSON（原 JSON 无 default 时同时写成 default），
    Spine「导入数据」直接可用。混搭预设存 `data/skins/`（只存「部位→皮肤」表，不含图）。
- `public/js/render.js` — 坐标换算与渲染。`layout()` 是唯一真源：
  `cx = p.x - bbox.x0 + dx`、`cy = bbox.y1 - p.y + dy`（Y 轴翻转）
- `public/js/compose.js` — 装配台。**新增函数记得加进末尾的 `return {...}` 导出列表**（踩过坑：没导出导致 `Compose.applyReplace is not a function`）
- `public/js/anim.js` — 动画台。调试线框要改 `player.config.debug.{bones,meshes,hulls}`（**不是** sceneRenderer 的字段，播放器每帧会覆盖）
- `public/js/cutter-mask.js` — 切割工坊算法库（**零依赖**：mask 位图/魔棒泛洪/连通域/形态学/羽化）
- `public/js/cutter-engine.js` — 切割工坊引擎（部件模型 + 三种自动切分 + 导出 JSON）
- `public/js/cutter.js` — 切割工坊 UI（画布交互/工具/部件列表/AI 识别/导出面板）
- `ai/ai_server.py` — **AI 智能切分常驻服务（端口 5311）**：YOLOv8-pose 定位 + SAM3 抠图。
  运行解释器是 `H:\【work】\photon Studio\.venv`（torch 2.14.1+cu130 / sam3 / ultralytics），路径配在 `ai/config.json`。
  模型首次加载约 30 秒后常驻；Node 侧 `server.js` 的 `/api/ai/*` 只做健康探测/惰性拉起/代理转发。
  **run_pose 返回的是 (kps,conf,box) 三元组**——踩过坑：返回元组当 dict 用 `.get` 会炸且被 try 吞成"未检出"。
  SAM3 蒙版 PNG 是**单通道灰度无 alpha**，前端解码判断要用**红通道**不能用 alpha。
- `vendor/spine-player.js` — 官方 3.8 运行时，**已打补丁**（见下）
- **spine-player 没有自带 CSS**（项目里也没有 spine-player.css，运行时不会自动注入样式）。
  裸用会出两类事故（2026-10-11 已修，样式补丁在 `style.css` 搜 `spine-player`）：
  ① canvas 无 CSS 宽高 → 在**隐藏页签里创建**播放器时 clientWidth=0，`resize(Expand)` 每帧把
  canvas.width 写 0，死循环 → 人物极小/相机错乱。宿主容器必须**有确定高度**（绝对定位铺满，
  或像动画台 `.player-host>div{width/height:100%!important}` 兜底；`.stage` 高度靠内容撑，百分比链会断）。
  ② 官方控制条（6 按钮 + spine logo SVG + LoadingScreen 大 logo）裸奔满屏 → 我们全部隐藏
  （`showControls:false` + `.spine-player-controls{display:none!important}`），
  并在 buildPlayer 后 `player.loadingScreen.draw=function(){}` 杀 LoadingScreen 大 logo。
  缩放做法：改 `player.currentViewport`（drawFrame 每帧按它算相机），围绕中心收缩 1/k。

## 切割工坊（第三个流水线）
- 用途：不装 PS，网页里「导入一张图 → 自动切部件 → 命名排序 → 导出 images+JSON 给 Spine」。
- **导出坐标铁律**：原图左上原点 Y 向下 → Spine「原点左下 Y 向上」：`x = bx + bw/2`，`y = H − (by + bh/2)`。装配台按相对 bbox 渲染，所以原点怎么定都不影响结果。
- 三种自动策略：`alpha`(透明背景连通域) / `bgcolor`(四边取样去背) / `grid`(网格均分)。
- **后端 `POST /api/cutter/export` 不要预删旧 PNG**（`fs.unlinkSync` 在部分环境被审计钩子拦截，实测删 17 个要 15 秒）；改成先覆盖写、响应后 `setTimeout` 异步清理。
- 自动切分的硬限制：靠像素连通性，**接触/重叠的部件会连成一块** → 用「2.5 · AI 智能识别」解决（SAM3 语义抠图，15 类部件分左右，实测 15/15 检出 12s）。

## UI 裁剪排查（本项目踩过）
- 切割工坊右侧工具箱被裁 265px 的根因：`.p-b` **在 CSS 里根本没定义**，作为 flex 列容器的子项按 block 撑高后被 `.panel` 的 `overflow:hidden` 裁掉。
- 已修：`.p-b{flex:1 1 auto;min-height:0;overflow-y:auto}` + 兜底 `.tab > *{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}`。
- **`.sel` 类名一物两用（2026-10-11）**：它既是表单下拉框 `<select class="sel">` 的样式，又是「选中态」标记（`.part.sel` / `.lyr.sel` / `.sk-row.sel`）。裸 `.sel{background:#fff;padding:5px 8px;border-radius:8px}` 会把白底+内边距串到舞台部件上 → **选中部件出现白框**。
  已修：表单规则限定为 `select.sel`，并给 `.part` 显式 `background:transparent;border:0;padding:0`。**以后新增 `class="sel"` 的表单元素要写成 `<select class="sel">`，不要再给非 select 元素加 `sel` 类。**
  **排查手法**：CDP 里遍历 `document.styleSheets` 用 `sel.matches(rule.selectorText)` 反查命中规则（比肉眼翻 CSS 快得多）；再用内联染色（`background:rgba(255,0,0,.65)`）确认白块归属哪个 DOM。

## 必须记住的补丁
`vendor/spine-player.js` 里两处
`if ("3.8.75" == skeletonData.version) throw new Error("Unsupported skeleton data...")`
已被改成 `if (false) {...}`。**重新下载运行时后必须重新打**，否则所有导出版都报
"could not load skeleton json"。

## 语义区分（重要，别搞混）
- **装配台** = PSD 原始扁平摆位（源 JSON）。等于「拖进 Spine 的样子」。
- **动画台** = 骨骼装配后的真实姿态（导出版）。pet0002 这类靠骨骼掰形的角色只有这里才是对的。

## 素材现状（2026-10-09）
6 个角色 / 132 个部件：j0000(18) j0001(15) j0002(21) j0003(34) pet0001(28) pet0002(16)。
有导出版：j0003（8 动作）、pet0001（6）、pet0002（8），均为 Spine **3.8.75**。
j0000 另有 `连续帧.json`（7 帧），暂未使用。
另有 **`[skin]j0000/`**：皮肤型源 JSON，`skins` 里 01/02/03 三套（每套 18 部位，共 54 个附件），
图片在 `[skin]images/01|02|03/`。三套确实是三套配色，但这批 PNG 本身**半透明**（head 不透明像素 74%、
hair 46%），所以画面上发灰 —— 不是渲染 bug。

## 切换演示 · 两种视图（2026-10-11）
- **游戏式（默认）**：每行 👁 + 部位名 + 当前缩略图 + ◀ + 下拉（含 ∅ 留空）+ ▶，箭头循环回绕。
  行数只随**部位数**线性增长，与皮肤数无关 → 适配 30+ 套皮肤。**矩阵**：全格总览，适合少量皮肤。
- 视图条 `#skViewGame/#skViewMatrix`，选择存 `localStorage.skView`；两种视图共享 `S.choice`，切换不丢状态。
- 统一入口 `renderView()`：**新增影响部位列表的改动要同时过 `renderView()`，别再直接调 `renderMatrix()`**。

## 动画换装（🎭 页签，会动的角色逐部位混搭，2026-10-11）
- 素材：`spine/<角色>/<导出目录>/`（Spine 运行库格式 json+atlas+一张整合 png），`skins` 是**数组**（皮肤名 `01/02/03`），动画只动骨骼。
- **技术核心**：`skeleton.setSkin(自建 mix 皮肤)` + `setSlotsToSetupPose()`；逐部位从 `skeleton.data.findSkin(sn).getAttachment(slotIndex, slotName)` 取附件塞进 `new spine.Skin(name)`。
  **前提**：该角色动画无 attachment 时间线，否则 mix 会被动画每帧覆盖（需要每帧在 `animationState.apply` 后重新 setAttachment）。
- 服务端 `GET /api/actskins`（`findExports` 已补 `skinCount`）；前端 `public/js/actskin.js`（window.ActSkin），复用 `spine.SpinePlayer`（success 拿 `p.skeleton`/`p.animationState`）。
- 与「切换演示」同源 UI：游戏式/矩阵两视图、◀▶循环、整套切换、∅留空、随机、保存/换装库（复用 `skinmix` 接口，modelId = 导出 dirRel 区分）。
- **atlas 打包无单图**：详情面板不显示单张缩略图，靠右侧「会动的角色」实时预览；若要单图预览得从 atlas 区域裁（WebGL 模式下 page.rendererObject 是纹理不是 img，较难）。
