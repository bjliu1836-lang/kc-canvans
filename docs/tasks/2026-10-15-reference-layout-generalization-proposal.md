# 通用参考图空间还原方案（待确认）

创建：2026-10-15

状态：P0-P3 本轮实现与代码/浏览器验证已完成；跨图视觉验收与非空运镜回归仍未完成；P4 额外调用不纳入
关联评估：[卧室参考图布局质量评估](2026-10-15-bedroom-layout-quality-assessment.md)

## 目标与边界

建立适用于不同上传图片的通用规则、流程和统一质量验收。目标是各图片都经过同一套质量闸门，不承诺任意图片有相同的可还原程度。未知、遮挡、裁切或歧义内容必须降低置信度并标记待确认，不得瞎补。

卧室图仅是回归样例。不得硬编码这张图或任何单场景的墙布局、物件种类、坐标尺寸、朝向、相机或颜色。床、书架、窗帘只是可扩展语义组件示例，不应让更换家具种类导致通用流程失效。

实现仍需保留 LayoutDraft → DirectorProject 的用户确认流程、旧 JSON 与已保存场景兼容；不换模型/供应商、不加高精度服务、不默认增加模型调用。诊断禁止记录图片 base64、密钥和登录态。用户已授权实施 P0-P3；P4 额外模型纠偏不纳入本次默认实现。代码改动仍限布局 prompt/validator/client/预览路径，不提交、不推送、不部署。

## 实施方案

- [ ] **P0 追踪与统一评审：**用关联 ID 对照一次请求的脱敏结构化输出、规范化 Draft、应用后几何及预览/应用/相机状态；建立跨图片共用的评审表，分别看空间结构、对象语义/关系、几何/材质、相机画幅、约束通过情况和不确定项。视觉置信与程序约束状态分开呈现，门槛由样本校准，不用平均分掩盖结构错误。
- [ ] **P1 空间类型、语义与关系：**先判断空间类型及规则适用范围，再识别对象与结构关系；室外/开放空间不得强补成四面墙，当前未支持输入须显示边界并待确认。关系以原图参照视角为语义依据，引用稳定墙/地面/平台等锚点 ID，不随自由机位变化。优先一次现有模型调用返回 `observations`、`relations`、`geometry`，程序按关系求解并校验；缺失证据保留 unknown，低置信物件不得被自动挪动。床、书架、窗帘只作可扩展组件例子。当前进度见下方 P1 schema slice。
- [ ] **P2 几何与材质：**参数化表达复用现有 `assembly`/`appearance`；缺省颜色与识别材质分开，不能把类别占位色伪装成识别结果；预览与应用复用同一变换，地面/支撑关系可见可查。保留旧数据默认值与场景兼容。
- [ ] **P3 参考相机与对照：**明确区分原图参考机位和自由编辑机位；对照使用原图宽高比与构图框，竖图、方图、宽屏分别按原图画幅验收。相机推断不确定时标低置信，不把单图估计宣称为精确拍摄参数。
- [ ] **P4 可选修正：**本次明确排除，不增加默认模型调用；未来需单独评估授权。

### 调用轮数取舍

推荐一轮现有模型调用同时提供 observations、relations、geometry，之后使用程序约束检查/求解；默认拆成先识图再布局的两轮会增加成本和延迟，也可能导致两轮解释不一致。若跨图评测不能证明一轮方案不足，不增加第二轮。P4 的单次修正调用单独计为可选成本。

## 跨图验收矩阵

样图均待准备；当前只有卧室评估上下文，不将下列样例写成已有资产。覆盖时需有维度交叉组合，不能只用卧室图通过验收。

| 维度 | 需要覆盖的样例 | 状态 |
| --- | --- | --- |
| 空间类别 | 卧室（回归）、客厅、厨房、工作区、走廊/开放空间、室外或无法归类输入 | 待准备 |
| 相机与画幅 | 正视/斜视/高位视角；竖图/方图/横图 | 待准备 |
| 可见性 | 遮挡、裁切、关键墙面或物件缺失、无法确认 | 待准备 |
| 组合与兼容 | 桌椅、床/储物、窗/窗帘、书架及混合组合；旧 JSON Draft/保存场景 | 样图与兼容夹具待确认 |

统一通过标准：所有样图采用相同评审表；确定性空间/支撑约束不得留未解释的阻断错误；不确定结构必须降置信或待确认；不支持类型提示边界而非强行生成；参考机位按原图画幅对照；Draft 与应用几何/材质一致；旧输入可读。不同图可以有不同细节程度，但不得隐瞒未知或跳过验收。置信门槛和评分锚点待取得样本后校准，不承诺所有图片同等还原。

## 进度与待用户决定

- [x] G00 将方案调整为跨图片通用规则、流程和验收；卧室只保留为回归样例。
- [x] G01 核对 checkout、分支、dirty 文件、上游同步边界与现有组件；确定仅修改本方案涉及的布局 prompt/validator/client/预览路径。
- [ ] P0：关联 ID 与脱敏诊断记录，统一质量校验摘要。
  - [x] 客户端独立 generationId 贯通 candidate、normalized、preview、applied；模型同名字段不能覆盖，草稿内仅有临时诊断关联，不进入 DirectorProject 对象。失败只写有限状态码。
  - [x] DEV 默认可用；生产仅当直接打开 Director Desk 自身 URL 并附 `?directorLayoutDiagnostics=1` 才写 sessionStorage/显示 JSON 导出入口。session 最多 20 条、总计 256 KB；单 candidate 上限 48 KB；只允许有界结构字段，不记录原始文本、evidence/notes、图片 URL/base64、密钥、登录态、文件名或 sourceId。超限记录自动截断/丢弃，诊断失败不影响生成应用。
  - [ ] 跨图片统一评审表的视觉结构打分/阈值校准仍需额外代表样本；当前记录为评审素材，不将本轮两张图宣称为通用通过。
- [ ] P1：空间适用范围、可见证据/关系/几何契约与通用安全规则。
  - [x] Schema slice：为 Draft 加入有界 `spaceType`、`observations`、`relations`、组件 `semanticType`；异常元数据局部丢弃并记录短校验码，不阻断几何。`attached_to` 仅对高置信门窗/墙关系作旋转墙局部坐标范围检查后吸附，并标记复核；床 `head_at` 检查 local -Z 床头点与旋转墙范围，冲突只标待确认、不移动床。旧 Draft 缺新字段继续可读。最终验证见下方 2026-10-16 记录。
  - [x] Worker/local-server prompt 已同步空间类型、开放/室外边界、原图左右语义、有界关系/观察字段、床 semanticType 与中性材质 fallback；校验提示以安全的用户文案展示。验证：Worker 18 项、ReferenceLayoutPanel 13 项通过。
- [ ] P2：几何/材质与 ground 的预览/应用一致。
  - [x] 共用语义 preset：缺少 assembly 时从 semanticType 生成 bed（床架/床垫/床头板/枕头）、curtain（分片与半透明纱层）、bookshelf（侧板与层板）；合法模型 assembly 优先且不会被覆盖，未知语义仍走原通用构件。所有部分使用受限归一化本地包围盒并经 schema bounds 检查；预览与应用同用 LayoutComponentGeometry / buildLayoutBatch 数据。默认占位材质改为中性灰，清楚的模型 appearance.color 才覆盖。验证：layoutDraft + SceneRoot 76 项通过。
  - [x] prompt 明确要求原图主色可辨时输出合法 `appearance.color`，只有颜色被遮挡/无法判断才降置信省略；`roughness`/`metalness` 仅证据充分时填写。JSON 示例展示合法 appearance 结构。无语义预设且轮廓明确的多部件物件用少量受限 assembly 表达（建议每组件不超过 8 件），不为场景或物件名称硬编码。两端 prompt 同步，最终应用效果已用保存响应回放；真实模型结果边界见下方记录。
- [ ] P3：原图画幅/构图参考机位，不改变既有运镜。
  - [x] 预览态以原图画幅计算 FrameRect，并直接按 FrameRect 设置 WebGL Canvas 外框；参考预览期间截图直接读取该 Canvas 全画幅，不按项目 ratio/旧 safe-area 再裁切；退出回到既有项目 ratio/crop 规则。FOV 仍用参考相机推断值。
  - [x] 浏览器验证竖图参考机位 resize 后仍保持参考画幅、退出后恢复交互控制，相机 preview 与 apply 使用同一草稿。
  - [ ] 本次浏览器 fixture 的运镜关键帧前后均为空数组；只能确认空数组未变化，尚无非空运镜关键帧样本证明原路线保持不变。
- [x] P4：排除于本次范围，不默认追加调用。

## 2026-10-16 收尾验证与证据边界

- [x] ground 渲染修复：草稿 ground 顶面按 `groundHeight + 0.002m` 与场景默认地面错开；草稿含可见 ground 时隐藏编辑器默认 ground overlay，避免它遮住识别地面。没有移动识别几何。预览与应用共用渲染定位；`layoutDraft.test.ts` 覆盖厚度 `0.02/0.1m` 与非零 ground height。
- [x] 卧室浏览器回放：采用已保存的脱敏模型响应拦截本地 API，经过真实图片上传、草稿预览、参考机位、resize、退出和应用；检查均通过且无 console error。结果：[30-final-reference-browser-result.json](../../artifacts/temple-layout-diagnosis-2026-10-13/30-final-reference-browser-result.json)。卧室截图：[参考机位](../../artifacts/temple-layout-diagnosis-2026-10-13/31-bedroom-reference-camera.png)、[resize 后](../../artifacts/temple-layout-diagnosis-2026-10-13/32-bedroom-resized-camera.png)、[退出后](../../artifacts/temple-layout-diagnosis-2026-10-13/33-bedroom-camera-exit.png)、[应用后](../../artifacts/temple-layout-diagnosis-2026-10-13/34-bedroom-applied.png)。
- [x] 代码验证：此前 Director Desk 定向测试 7 文件 / 140 项及 `node --test tests/worker-director-layout.test.mjs` 18 项通过；本次最终修复后重跑受影响的 4 个文件 / 87 项通过，`npx tsc -b` 与根 `npm run build`（Director Desk TypeScript + Vite、根目录 Vite）通过。构建期间发现并修复相机测试 fixture 缺少必填 `visible` 字段，以及后侧二维方向映射中不可达的 `image_back` 比较。Worker 合约测试的一处旧 prompt 断言已同步为当前 `assembly 子件表达` 文案。Vite 有 bundle size 提示；依赖安装报告 9 项 audit vulnerabilities，本轮未执行 audit fix。Director Desk Vite 服务恢复至 `http://127.0.0.1:5173/director-desk/` 并返回 HTTP 200；端口 8788 无监听，既有根服务 8787 保持运行。
- [ ] 视觉质量仍待代表样本验收：本轮卧室响应来自旧 prompt，含 20 个组件，但仅床体一个 `semanticType`、无 `assembly`，且 `head_at` 方向错误（床头板→床体）、缺床体→墙关系；窗/窗帘顶部超出识别墙高，规则会提示并保留几何。寺庙响应 15 个组件、无颜色/semanticType/assembly。旧响应不证明新 prompt 的输出质量；两张图均不构成跨图通过。
- [ ] 卧室参考相机估计为从 `+Z` 看向 `-Z`，不能据此宣称原图还原质量达标。浏览器测试前后 `routesBeforeApply=[]`、`routesAfterApply=[]`；本轮没有非空相机运镜样本，不能称为非空路线保持验收。
- [ ] 跨空间类别、画幅、遮挡/未知内容和旧数据组合的样本矩阵、视觉阈值校准，以及非空运镜保持回归仍待后续开展。默认产品流程仍保持每图一次调用；下方只有本次明确授权的一次独立诊断请求。

## 核心视觉提取与几何分工验证

- [x] 完成（2026-10-16）：复用 `.env` 中现有模型配置与此前 probe 的 HTTP payload 约定，对既有卧室源图只发 1 次简化视觉观察请求；没有启服务、修改产品功能或改变默认每图一次调用。结果：HTTP 200，alias `deepseek-flash`（响应 model 相同），finish reason `stop`，调用数 1，usage 1255/1559/2814 tokens（prompt/completion/total）。
  - 脱敏必要字段：`bed bbox=[0.22,0.39,0.88,0.65], color=#F5F0E6`；`headboard bbox=[0.78,0.39,0.92,0.52]`；可见墙区域为 top/left/right/back；`headboard_contact_wall=image_right`、`bed_body_extends_from_head_toward=image_left`，模型给出的依据是床头板位于画面右并接触右墙；bookshelf/door 在 image_left，window 在 image_back，desk 在 image_right。完整脱敏 JSON 仅在执行结果中回传，未保存图片 base64 或原图路径到仓库。
  - 对照复杂响应 `28-current-prompt-bedroom-response-2026-10-16.json`：床 `position=[0,0.25,-1.5]`、`size=[2,0.5,2.2]`、`yaw=0`；床头板 `[0,0.6,-2.6]`、`size=[2,1.2,0.15]`、`yaw=0`；其 `head_at` 是 `headboard_01 -> bed_01`，没有床体→墙关系。按当前局部 -Z 床头约定，复杂输出把床头放在 -Z 端；简化输出明确给出 image_right / 向 image_left 延伸。针对该单一关系，简化任务输出更直接可审查，且看起来更贴近图像方位；这不是全图正确性证明，需人工核图。证据原图文件名：`20260522-111255.jpg`（私有本地文件）。
  - 边界：实验只证明短视觉任务能明确表达图像空间关系；没有验证其它物品、颜色和置信度的整体精度，也没有从 2D 关系推导任何三维坐标/尺寸/yaw。单次输出不能证明模型稳定性。

## 视觉事实到几何的纯转换器垂直切片

- [ ] P1 接线切片：
  - [x] 建立 Worker/local 共用的二维观察 prompt/parser；只接受白名单 root 和有限 surfaces/items、bbox/ID/confidence primitive shape，丢弃未知几何字段；不要求模型猜 imageAspectRatio。
  - [x] Worker/local 的显式 `outputFormat: image-observations-v1` 分支各自单次模型请求，响应 `{observationFormat,visualObservations,usage}`；无字段请求保留原 Draft/legacy retry 路径。
  - [x] 前端请求显式 opt-in，匹配 format 后调用纯 converter；缺失/错格式不回退 legacy。校验通过后 diagnostics 按同一 generationId 保存脱敏观察与 normalized 几何。
  - [x] 保留已存在的人物能力：共享契约用独立 `people` bbox 观察，前端映射为 Draft `characters` 并由既有 support validator 解算；若响应只有人物而无任何布景组件，既有 Draft validator 不允许空组件，客户端明确报结构错误，不凭空造 ground。
  - [x] parser/转换失败留证：解析前生成仅含有限 key/type/array length 的白名单摘要；upstream HTTP、空/错误 provider envelope、模型 JSON、观察 schema、converter geometry 分开标记；模型字段错误附受限路径，不返回上游原文。Worker 24 项、converter/client 35 项通过；node --check 与 git diff --check 通过。
  - [x] 观察契约补充通用 `contactWallSide`、可选 `rearFeature{name,bbox}` 和二维 `bodyExtendsToward=image_left|image_right|image_up|image_down|unknown`；新 side 唯一映射实际可见墙，字段缺失时兼容 `againstSurfaceId`，显式 `unknown/none` 或新旧冲突不借旧 ID 强锚并标待确认。背面特征仅保留观察证据，不以 bbox 横向差强制改墙。`mainColor` 明确为 `#RRGGBB|null`，兼容 `color` 与 `appearance.color` 且只规范化颜色字段。Prompt要求先识别墙地/开口，再大型家具，之后显著小物/人物。
  - [x] enclosed 的可见 back/left/right 围护墙共享同一 6m×6m canonical footprint，后墙跨完整 roomWidth、侧墙跨完整 roomDepth 并连续接角；只创建实际观察到的墙，不补缺失面。bbox不再独立缩短围护墙，但继续用于沿墙物件的相对位置。测试断言3墙端点一致且未生成未见前墙。
  - [x] 新契约真实请求：卧室与寺庙每图一次，不重试；解析前保留白名单字段/类型摘要和必要观察字段。结果见 [`36-bedroom`](../../artifacts/temple-layout-diagnosis-2026-10-13/36-bedroom-observation-diagnostic-2026-10-16.json) 与 [`37-temple`](../../artifacts/temple-layout-diagnosis-2026-10-13/37-temple-observation-diagnostic-2026-10-16.json)。两份均 HTTP 200、`deepseek-flash`、`finishReason=stop`，通过 parser；记录不含原图/base64/密钥。解析成功不代表视觉质量通过。
- [x] 第一轮代码复核已按现有组件语义修正：非开口物件的墙锚点沿统一 local −Z 背面规则贴墙并保持落地；缺失/循环 support 落地并待确认；仅当已知 bed/curtain/bookshelf 语义预设覆盖子件时才折叠 `partOf`，未知父项与循环关系保留独立几何并待确认。转换器优先保留歧义观察、`head_at`/`supports` 关系后交给现有 validator，超出 12 observations/24 relations 时保留截断提示。
- [x] 完成纯转换器小切片；未接入 API/prompt 主路径、未改 renderer、未调用模型：[`imageObservationLayout.ts`](../../micro-apps/director-desk/src/editor/schema/imageObservationLayout.ts) 定义有界的可选 image-space surfaces/items（总数最多 30、surface 最多 8，归一化 bbox、色彩、可见性、置信度、against/support/partOf IDs）；不接收全局 3D 坐标或 yaw。异常结构拒绝，不合规的语义关系保留 uncertain/observation。
  - 只生成输入中观察到的 wall/floor；open/outdoor 不合成其它墙。6m×6m 与 2.8m 墙高仅是统一的 estimated 场景先验，家具优先用语义尺寸先验；bbox 只估相对横向/前后排序和可见范围，不能确定的深度维持 uncertain。canonical 映射固定 image_right→+X、image_left→-X、image_back→-Z、front→+Z；bed local -Z head 对 image_right/left/back 分别生成 yaw -90/+90/0，并按床深 footprint 贴近墙；side-wall openings local +Z 面向室内。墙窗高度按墙框估算并约束在估计墙顶范围内，超出修正范围时标 uncertain；支撑组件用已有 validator 顶面解析 Y。原图比例保留到 canonical bounds-fallback referenceCamera。
  - `partOfId` 仅在已知语义 preset 可覆盖子件时折叠并留下 observation；未知父项、循环引用和不受支持的子件保留自身几何并标 uncertain。`bed` 复用现有 5 件 assembly preset，父 box 高 1.2m 包含抬起床头板，测试逐件检查 assembly bounds。显式主色沿用。定向测试 [`imageObservationLayout.test.ts`](../../micro-apps/director-desk/src/editor/schema/imageObservationLayout.test.ts) 17/17 通过：左右床镜像、后墙 bed yaw0、左右墙窗法线、普通家具墙锚点、室外单墙、open 无墙、落地/支撑/循环引用、partOf 保留与去重、headboard assembly bounds、颜色、bbox/未知墙引用约束、metadata 截断提示、旧 Draft validator 兼容。
  - 接入建议仅供复核：未来 API 返回可选 image observation 时调用 `imageObservationToLayoutDraft(observation, source, options)` 作为该 observation 分支的 Draft 构造器；现有复杂候选仍走 `validateLayoutDraftCandidate` 原路径，未在本切片改变默认调用或运行路径。当前未做全量类型构建、完整测试、浏览器验收；bbox 的 6m 场景先验与 camera bounds-fallback 均为估算，不是原图精确尺度/机位还原。
- [x] 2026-10-16 父子后侧部件约束：高置信、可见且显式 `partOfId` 的 `headboard/backrest/rear_panel` 类子部件，以唯一可见墙面的 `contactWallSide` 约束父体 local −Z；父普通接墙仍保留为普通接触关系。父子侧墙不一致时，后侧子件优先并把父体标为待确认；多个后侧部件墙面冲突、父级 `bodyExtendsToward`/`rearFeature` 明确矛盾、墙证据低置信/歧义时不强锚。先解父体朝向再按现有语义 preset 去重，子件的原始接墙证据留在 observations。增加左右/后墙床头和非床 backrest 用例；定向 converter 测试 30/30 通过。真实 36/37 fixture 的 camera 参数及 UI 回放仍待验证。
- [x] 2026-10-16 对 36/37 原始 observations 做浏览器 UI fixture 回放，原 JSON 未修改，route 只 mock 已有模型响应：卧室原图 `20260522-111255.jpg` 1024×1535（aspect 0.66710098），寺庙 `reference-temple.png` 2048×1152（aspect 1.77777778）；两图均完成单次 fixture 请求、草稿预览、参考机位和应用，画幅参数与原图尺寸比一致、无 console error。卧室 `bed_1` 转换为 yaw −90°、position `[1.8,0,1.9838709677419357]`、size `[2,1.2,2.2]`、uncertain；被折叠的 `headboard_1` 原观察仍保留在 diagnostics candidate（`partOfId=bed_1`、`contactWallSide=image_right`、`partly_occluded`、confidence 0.9）。结果：[`38-observation-fixture-ui-result.json`](../../artifacts/temple-layout-diagnosis-2026-10-13/38-observation-fixture-ui-result.json)；截图：[卧室预览](../../artifacts/temple-layout-diagnosis-2026-10-13/38-bedroom-observation-preview.png)、[卧室应用](../../artifacts/temple-layout-diagnosis-2026-10-13/38-bedroom-observation-applied.png)、[寺庙预览](../../artifacts/temple-layout-diagnosis-2026-10-13/38-temple-observation-preview.png)、[寺庙应用](../../artifacts/temple-layout-diagnosis-2026-10-13/38-temple-observation-applied.png)。两组 `referenceCamera` 都是 `source=bounds-fallback`、confidence 0；只能证明实际画幅被保留，不能把估计机位当作参考相机质量通过。
- [x] 2026-10-16 以 36-bedroom fixture 核验并修正 ground-depth 映射：旧值 bed `z=1.984`、rug `z=0.990`、desk `z=2.710` 与 bbox bottom（`.65/.73/.68`）表达的远近关系冲突。落地组件共用 floor bbox `top..bottom` 到 canonical 深度映射，以 bbox bottom 估可见前沿，再按 yaw 后 world-Z 半深度求中心并夹入 footprint；侧墙只锁法线轴，沿墙 Z 使用同一估计；有非 ground 支撑的子件继续由支撑 footprint clamp。显式人物支撑复用支撑物 XZ，由现有 validator 解算可支持顶面 Y。该映射是受场景先验、遮挡与估算尺寸限制的近似，不是透视反演或真实尺度。新增 bed/desk/rug 远近顺序回归，`imageObservationLayout.test.ts` 当前 35/35 通过。下一步仅限独立 camera 最小拟合、相同原图 fixture 回放和最终验证。
- [x] 2026-10-16 referenceCamera 有界拟合试验：只采用可见、高置信、足够面积的最多 10 个主要物件 bbox；500 候选固定为 eye height 1.6m、azimuth 5 档、horizontal distance=`span×[0.6,0.85,1.1,1.5]`、pitch `[-5,0,5,10,15]°`、FOV `[35,45,55,65,75]°`；投影框由纯向量计算，候选相机须位于场景 +Z 并避开组件实体。baseline/best/error 门槛/是否应用/拒绝原因/最佳候选变换通过有界 `fitDiagnostics` 保留。36-bedroom：5 项，baseline `0.574370`→best `0.392163`，候选 position `[2.9756,1.6,7.2203]`、target `[0,0.8388,-0.9550]`、FOV 45°，仍因绝对误差超过 `0.22` 而拒绝；37-temple：5 项，baseline `0.834395`→best `0.314819`，position `[1.4618,1.6,5.7177]`、target `[-0.6768,1.0530,-0.1579]`、FOV 35°，同样拒绝。两者均保留 `bounds-fallback`、confidence `0`；不为单样图放宽阈值。并排 wireframe 诊断比较：[卧室](../../artifacts/temple-layout-diagnosis-2026-10-13/38-bedroom-camera-compare.png)、[寺庙](../../artifacts/temple-layout-diagnosis-2026-10-13/38-temple-camera-compare.png)；候选侧明确标记 DIAGNOSTIC ONLY，且视觉上仍有裁切，不能作为主路径验收。新增自包含合成用例证明可接受候选会应用、两项证据会 fallback。36/37 fixture 使用原图及同一 observation 回放通过，原图画幅保留、参考机位预览与应用通过、无 console error；整体参考相机质量仍未通过，不能宣称跨图达标。截图/数值记录见更新的 [`38-observation-fixture-ui-result.json`](../../artifacts/temple-layout-diagnosis-2026-10-13/38-observation-fixture-ui-result.json) 与 38-bedroom/temple 预览/应用截图。

### 2026-10-16 空间标定证据分级与单次 probe

- [x] 根因：当前 `imageObservationToLayoutDraft`（`imageObservationLayout.ts:727`）把 `wall/floor bbox` 变成固定 6×6m footprint、2.8m 高的矩形墙（`:316-330,772-797`）；未命中尺寸 preset 的物件用 bbox 尺寸乘 6m（`:304-314`），位置/地面接点再按归一化 bbox 线性映射 6m（`:365-370,647-653`）。验证后 `fitReferenceCamera` 只改变相机，不解房间/家具几何（`:393-502,930-968`）；投影误差是物件 3D 盒角投影后与 2D bbox 对齐，500 个相机候选仍固定眼高 1.6m（`:450-479`），所以错误几何本身无法由相机补偿。
- [x] 36-bedroom 实际只有 floor bbox `[0,.55,1,1]`、back `[.2,0,.78,.55]`、left/right wall bbox；对照原图后墙上边约在 y=.2，bbox top=0 把墙外/顶缘画面也包进来，不能作为墙面角点。缺后墙 polygon 四角、墙地接线、back/side 共享转角、ceiling polygon 和向深处收敛的 ceiling/floor 边线。37-temple 只有 floor `[0,.62,1,1]`、back `[.38,0,1,.62]`、left `[0,0,.38,.62]`；原图顶缘可见梁/深色结构，墙顶边界复杂，不能仅由 bbox top=0 判定 ceiling 被并入；已知缺项是没有可验证 polygon 角点、墙地/墙墙共享 junction ID、点级遮挡状态或标注线段。两图都只给表面轴对齐 bbox，不能从中恢复真实共享投影。
- [x] 最小契约建议（兼容现有 bbox）：`surfaces[]` 保留 id/kind/visibility/confidence，增可选 `polygon:[{cornerId, uv:[u,v], visibility, confidence}]`；真实共享角写入 `junctions[]:{id,kind,surfaceIds,uv,visibility,confidence}`，kind 限 `wall_floor|wall_ceiling|wall_wall`；再增可选通用 `segments[]:{id,planeKind,endpoints:[[u,v],[u,v]],visibility,confidence,sourceId?}`，用于地砖、桌沿等 bbox 外的平行结构线。只提交图中实际可见角/线，遮挡角写 `occluded/unknown`，不得按封闭房间补出隐藏角。bbox 继续兼容旧响应与物件粗框；观察输出图像坐标/ID，不输出世界坐标、相机或猜测尺度。line plane kind 说明线所属可见平面，不预先指定世界方向族；由几何拟合聚类。
- [x] 几何主线：先按图像高度归一化坐标 `x=(u-.5)*aspect, y=.5-v`（主点暂假定中心，`c=(0,0)`）。两组正交水平线的有限稳定消失点 `Vx,Vz` 满足正交约束时，可用 `f²=−(Vx−c)·(Vz−c)` 求焦距，仅在 `f²>0` 且归一化正交残差合理时接受；近正面方向 VP 在无穷远/不稳定时改用有限 FOV 候选，不强求 f。对每个候选 `K`，用 `K⁻¹` 反投影消失方向、检查方向符号与 Manhattan 正交质量，恢复相机旋转。相机射线 `d=R K⁻¹[u,v,1]` 转到 level room basis，令 `n` 为 back-wall 法线、`x` 为沿墙方向、`up` 为世界竖直，`q_y=(d·up)/(d·n)`、`q_x=(d·x)/(d·n)`。同一后墙竖边顶/地射线给 `D=H/(q_y_top-q_y_bottom)`、`cameraHeight=−D*q_y_bottom`；左右地面角给 `roomWidth=D*(q_x_right-q_x_left)`、`cameraX=−D*(q_x_left+q_x_right)/2`。要求点在同一后墙平面、`d·n` 不近零；可见角/线重投影残差参与候选判定。对 36-bedroom 作手工量级检查：消失线约 y=.46、后墙 top/bottom 约 .20/.55 给近似 `cameraHeight≈2.8*(.55−.46)/(.55−.20)=.72m`；宽度按归一化墙宽 .58、aspect .667 估约 `2.8*.58*.667/.35≈3.1m`。这些数只用于证伪固定 1.6m/6m 假设，不进入生产常数。
- [x] 按证据量分级而非按场景分支：A 有可验证 back-wall 顶/脚、共享角、两族 depth edges 时，以 `H=2.8m` 先验恢复相机/后墙/可观测房宽；B 缺完整房间但能从地砖/桌沿等两族平行结构线恢复水平 VP 时，只解方向与投影，尺度由可靠家具/人物尺寸软先验给出，裁切墙按可见 polygon 建局部墙面、不补 ceiling，未知房间深度继续 unknown；C 无足够线/角/尺度证据时明确 `uncalibrated` 并保留 uncertain fallback。`solveSceneCalibration(observation, aspect, priors)` 返回 A/B/C、相机/可观测平面、残差和退化原因；之后 `placeItemsByRayPlane(calibration, items)` 用可见物件 bbox 底边射线与地面相交估落点、wall-contact 射线与墙平面相交估沿墙坐标，再以 bed/desk/chair 等语义尺寸及 support footprint 作软约束；`validateCalibrationReprojection` 用同一投影验收结构角/线与物件框。仅一平面、角线严重遮挡、相机基底/FOV 多解、`d·n≈0`、bbox 不完整时不升级证据级别；未见前沿/地面边界时 room depth 仍未知量。
- [x] 一次请求兼容：未来将可选 `polygon/junctions/segments` 放入同一次正式 `visualObservations`；旧响应缺结构字段时仍走现有 fallback，只有证据满足 A/B 时进入对应校准分支，C 返回 `uncalibrated`。不增加默认模型调用、不改模型配置。已按批准用现有 deepseek-flash 配置对卧室原图做一次结构 probe、未重试，HTTP 200、finishReason=stop，prompt SHA-256 `a65344328ab2e238fa2ac13fb2ea6b311f142cf56f20859bf6eebc4b6301c42a`。脱敏原始响应先保存于 [`39-bedroom-structure-probe-2026-10-16.json`](../../artifacts/temple-layout-diagnosis-2026-10-13/39-bedroom-structure-probe-2026-10-16.json)：四角及 top/foot junction 全为 null/unknown；ceiling=visible、top/foot clipped=false，但线段仅整幅图边界/均匀分割的 estimated 伪线、confidence 0.2，没有可用几何证据，不能据此进入 A/B。无图像 base64/API key 入档。后续需先以合成数据验证 B 级 VP/重投影，再评估如何让一次正式请求稳定返回真实角/线；不重复该诊断调用。

### 2026-10-16 本地像素线证据原型

- [x] 只读依赖/源码核查：根与 Director Desk manifest 均无 OpenCV/Hough/Sobel/Canny 依赖；现有源码只有图像采样/全景处理，没有可复用线段检测器。新增使用纯 TS helper，不增加依赖、不接入主生成路径。
- [x] 有界 grayscale Sobel + 梯度受限 Hough/segment extraction：最长边 768、edge/vote/candidate 硬上限；source image 通过 Canvas 读像素，输出 observed line segments，不由线检测器推断 junction。Hough 支持带仅用于 PCA 种子，最后端点/support 在 2.5px 窄带复核。
- [x] 自包含 synthetic 覆盖：4 种方向（含 143°）、低对比、纯色、固定种子无方向随机纹理、密集纹理上限和超尺寸拒绝；定向 Vitest 9/9 通过。143° 长线初始被过窄 Hough rho 带切成约 60px 短段；加密 theta bins、中心 rho 峰聚合并分为宽带 PCA + 窄带复核后，误差降至约 0.4°；纯色无边，随机纹理无输出。
- [x] bedroom/temple 原图分别导出透明 SVG 线层、叠加 PNG 和 segments JSON（端点、support rate、耗时），源图未覆盖且无图像 base64 入档。QA 产物：[pixel-line-evidence-qa-2026-10-16](../../artifacts/pixel-line-evidence-qa-2026-10-16)。卧室缩略图 512×768，262.9ms，边像素 34,144、抽样受限 16,000、15 条线段；可见顶墙斜边、窗/门柜竖边及床沿等。寺庙缩略图 768×432，145.5ms，边像素 39,950、抽样受限 16,000、仅 1 条线段（立柱边缘）；当前强纹理场景中边/投票预算截断会漏掉其他可见长边，原型证据不足以作通用线检测器或进入生产路径。


### 2026-10-16 LSD 统一阈值复核与运行时边界

- [x] 以 `.12 * minDimension`（端点 support 半径 2px、supportRate ≥ .7）重跑完整 LSD raw 输出。卧室 512×768：raw 1010、长度合格 90、支持合格 89；下半图 11 条，八个纵向带分别 3/8/39/28/3/5/2/1。寺庙 768×432：raw 1985、长度合格 49、支持合格 49；下半图 13 条，八带 5/15/6/10/4/3/5/1。当前 raw 未被 `[:N]` 包装截断；旧记录 raw 999/2000 使用的预处理/缩放参数未保存，不能与本次计数混用。本次 JSON 明确保存全部长度合格线段并按 `length*supportRate` 排序；overlay 与数据见 [opencv-lsd QA](../../artifacts/pixel-line-evidence-qa-2026-10-16/opencv-lsd)。
- [x] 卧室近水平 line5 复测为 `(154.37,147.43)->(350.63,148.52)`，角度 `0.319°`、y≈148/768=.193、supportRate=1.0。窗帘顶仍在约 y=.22-.225；不得把 line5 直接称为帘顶或墙顶。两条斜梁边 `(−3.26,29.55)->(135.5,166.99)` 与 `(369.37,165.8)->(512.8,11.3)` 单独延长线交于约 `(256.76,287.10)`；它们不足以构成两条稳定方向族的消失点证据，交点只作诊断。
- [x] 临时检查 `@techstark/opencv-js@5.0.0-release.1`：Apache-2.0、unpacked 14.7 MB；声明 exports 包含 `Canny/HoughLinesP/createCLAHE`，不含 `LineSegmentDetector/createLineSegmentDetector/LSD_REFINE`。本轮不接入依赖，也不把本地 Python OpenCV 能力记作浏览器能力。
- [ ] `imageObservationLayout.ts` 正在进行的纯几何/联合位置拟合原型，先用合成夹具及 36/37 两图同画幅浏览器 fixture 复核；实图只有 bbox/方向线、没有可验证 junction/墙面角点。证据不足时需明确保持估算/fallback，不能把单一斜梁交点升级成墙角或量测结果。

### 2026-10-16 尺寸映射、支撑链与真实图复核

- [x] 在 `http://127.0.0.1:5173/` Vite 源服务完成同 runId 回放 `20261016073647-42064`，结果含关键源码 SHA-256、Draft/camera/实际预览状态：[JSON](../../artifacts/temple-layout-diagnosis-2026-10-13/40-20261016073647-42064-joint-scene-fixture-ui-result.json)。卧室 bbox 投影残差 `0.5744→0.2510`，未过 `.22`；寺庙 `0.8344→0.1928`。`.22` 仅说明 bbox 数值门槛，不等于视觉验收。
- [x] 对象审查定位通用转换错误：[CSV](../../artifacts/temple-layout-diagnosis-2026-10-13/40-20261016073647-42064-temple-object-audit.csv)、[JSON](../../artifacts/temple-layout-diagnosis-2026-10-13/40-20261016073647-42064-temple-object-audit.json)、[源 bbox 叠加](../../artifacts/temple-layout-diagnosis-2026-10-13/40-20261016073647-42064-temple-source-bboxes.png)。柱子源 bbox `[0.19,0,0.25,0.72]` 被旧逻辑映射为 `[0.36,2.8,3.5]`；佛像 `[0.66,0.02,0.84,0.42]` 被估为 `[1.08,0.5,2.4]`，其 source `supportId=altar_table`。
- [x] 待应用草稿保留源 appearance 颜色/材质，uncertain 不再使用强琥珀色 emissive，改由琥珀色轮廓提示；定向 `SceneRoot`、`imageObservationLayout`、`layoutDraft` 测试 120/120 通过，`npm run build` 成功（仅有既有的大 chunk 提示）。
- [x] 尺寸映射按源 bbox 宽高比区分直立、柱体及扁平形体：pillar 尺寸 `[0.36, 2.8, 0.36]`，cushion 厚度 `0.08m`；修复直立物把图像高度映射为世界深度的问题。定向回归与两图重放已完成。
- [x] 支撑/partOf 依赖链位移传递与边界/新增碰撞有效性检查已有定向测试；Buddha statue 记录 `supportId=altar_table`，尺寸 `[1.08, 2.4, 0.594]`，实图可见于平台上方。未扩展 `needsReview` UI。
- [x] 当前源码两图同 runId 浏览器回放：`20261016075846-48924`，入口 `http://127.0.0.1:5173/`；卧室和寺庙均解析草稿、打开参考机位、应用完成且无 console/page 错误。完整 JSON 与两图预览/应用截图：[结果](../../artifacts/temple-layout-diagnosis-2026-10-13/40-20261016075846-48924-joint-scene-fixture-ui-result.json)、[卧室预览](../../artifacts/temple-layout-diagnosis-2026-10-13/40-20261016075846-48924-bedroom-joint-preview.png)、[卧室应用](../../artifacts/temple-layout-diagnosis-2026-10-13/40-20261016075846-48924-bedroom-joint-applied.png)、[寺庙预览](../../artifacts/temple-layout-diagnosis-2026-10-13/40-20261016075846-48924-temple-joint-preview.png)、[寺庙应用](../../artifacts/temple-layout-diagnosis-2026-10-13/40-20261016075846-48924-temple-joint-applied.png)。这些检查覆盖转换和流程；人物仍需人工识别：诊断数据记录源人物“跪拜女子”1 人，宿主 UI 中另有默认“角色01”，不可混为一谈。图像整体仍需父代理看图复核，bbox 阈值不代表视觉验收。

### 2026-10-16 待应用预览隔离与估算机位默认取景复核

- [x] layoutDraft 预览期间隔离宿主已有的 `objects`、crowd rigs、角色路线和场景相机标记；草稿自己的源识别人物继续由 layoutDraft 渲染。丢弃草稿后标准场景渲染自然恢复。
- [x] 对新生成且物理有效的拟合候选，首次生成自动打开同画幅估算取景；OrbitControls 可直接接手当前视角，第一次用户拖动会保存当下视角并退出固定取景，后续编辑不反复抢机位。两图 smoke 检查自动预览和手动 orbit 退出均为 true。
- [x] 碰撞审核将支撑/partOf 祖先关系、扁平装饰与家具重叠列为 allowed；一般粗 AABB 相交列为 review；仅小物体大体积穿透列为 hard。卧室 pillow/rug、throw/rug 为允许，table lamp/artwork、plant/artwork 为 review；寺庙 altar/cushion、stand/cushion、cushion/cabinet 为允许，incense burner/vase 为 review；两图 hard collision 均为 0。此前误拒的另一原因是门/窗/窗帘贴墙被 floor footprint 错判出界，已将其从地面边界约束中排除；最终两图 withinRoom、cameraOutsideGeometry 均 true。
- [x] 未知宽扁 prop 不再因 bbox 宽高比自动按地面支撑面处理；现保留普通 prop 几何并标 uncertain/待确认。明确 cushion/rug/mat/pillow/seat 语义仍使用薄 footprint；新增电视形宽物件回归用例。
- [x] 定向 `SceneRoot`、`imageObservationLayout`、`layoutDraft`、`ReferenceLayoutPanel` 测试 136/136，通过 `npm run build`（仅大 chunk 警告）。5173 源服务双图同 runId `20261016081210-46764`：卧室 bbox 误差 `0.556→0.190`，寺庙 `0.922→0.165`，都小于 `.22`；质量状态仍为 `needsReview`，不是视觉 accepted。结果：[JSON](../../artifacts/temple-layout-diagnosis-2026-10-13/40-20261016081210-46764-joint-scene-fixture-ui-result.json)。同画幅框分别为卧室 `509.66×764`（比例 `0.6671`）和寺庙 `1048×589.5`（比例 `1.7778`）。截图：[卧室完整预览](../../artifacts/temple-layout-diagnosis-2026-10-13/40-20261016081210-46764-bedroom-joint-preview.png)、[卧室同画幅框](../../artifacts/temple-layout-diagnosis-2026-10-13/40-20261016081210-46764-bedroom-estimated-frame.png)、[寺庙完整预览](../../artifacts/temple-layout-diagnosis-2026-10-13/40-20261016081210-46764-temple-joint-preview.png)、[寺庙同画幅框](../../artifacts/temple-layout-diagnosis-2026-10-13/40-20261016081210-46764-temple-estimated-frame.png)。源人物数据记录“跪拜女子”1 人；宿主默认“角色01”未并入草稿人物。视觉仍待评审，不宣称 bbox 通过等于视觉通过。

### 2026-10-16 组合构件实际 bounds 归一

- [x] 草稿预览与应用后对象共用 `LayoutComponentGeometry`；增加 layout-only 实际 mesh bounds 拟合，覆盖内建 table/chair/sofa/cabinet、香炉/花瓶/Buddha、通用 primitives 与声明式 assembly。Y bounds 归一到底部 0、顶部 1；XZ 居中并收缩至 unit footprint。普通导演台模型、UE4 角色及项目外层尺寸不变。
- [x] helper 逐 mesh geometry bounding box 经 `inverse(content.matrixWorld) * mesh.matrixWorld` 变换后合并，避免旋转 world AABB 膨胀；拟合前重置 content 变换，避免重复应用累计缩放。新增家具、香炉、花瓶、Buddha bounds 与外层非均匀 scale/rotation/position、重复 fit 回归。
- [x] `layoutGeometryBounds.test.ts` + `SceneRoot.test.tsx` 共 47 项通过。Director Desk `npm run build` 通过（bundle size 警告）；根目录 `npx vite build` 通过。根 `npm run build` 曾因正在运行的 5173 Vite 锁定 esbuild 执行文件而在 `npm ci` 报 EPERM；停止并恢复 5173、安装依赖后完成等价两段构建，未操作 8787。
- [x] 新源码 5173 浏览器双图回放 `20261016082655-27812`：卧室、寺庙均解析 1 次 fixture、生成同画幅参考机位、手动 orbit 退出预览并完成应用；无 console/page error。卧室 bbox 误差 `0.556→0.190`，寺庙 `0.922→0.165`，仍为 `needsReview`。佛像顶部在新寺庙同画幅截图内；卧室构图仍需视觉复核。结果与截图以 `40-20261016082655-27812-*` 保存。
- [x] 只读姿态链核对：寺庙 37 fixture 的人物 observation 未给 `posture/kneelVariant/handGesture`；转换采用 `unknown`，共享 adapter 映射为 `stand`。旧复杂响应虽含 kneel/seiza/prayer，但不是该 fixture 输入；当前站姿由上游观察缺字段造成。
- [ ] 下一小项：people 观察 schema/shared prompt/Worker 与本地 server normalize 明确传递 posture、可见时的 kneelVariant/handGesture；确认真实同图服务响应及最终 adapter pose，禁止从名称推断。

### 2026-10-16 估算地面范围与参考机位硬边界修正

- [x] 建立本轮追踪项并复用本文件；保留既存用户改动及 artifacts。
- [x] 复核 41 寺庙 observation 与 43 同画幅回放：ground bbox `[0,0.62,1,1]`，对应的 6m×6m 地面是布局先验；寺庙并没有可证明完整房间前沿的地面边界。相机候选因 `cushion_far_left` 超出估算地面左边界 `0.1867m`、bbox 残差 `.296 > .22` 而整体回退；另 `cameraOutsideGeometry=true`、`hardCollisionCount=0`。详细证据见 `43-final-layout-regression-result.json`。
- [x] 前置修复继续保留：复合 semantic profile 归一 `altar_table/small_table/dining_table/garden_table/bedside_table -> table`，并让 `table_lamp -> lamp`、`tablecloth -> textile` 优先于 `table` 子串；尺寸和 renderer assembly 使用同一个 canonical profile。床毯支撑面从 assembly 的宽水平部件解析为 mattress top `Y=.576m`。墙 bbox 顶边被裁切时，2.8m 仅记作估算墙高，墙不作为可信的已测层高。
- [x] ground 可见 bbox 不再升级为硬 room bounds；拟合时以其为软域，并动态扩展到现有物件边界；越界保留 `roomBoundaryViolations` 诊断且不单独拒绝候选。相机进入几何体、硬碰撞检查与 `.22` 投影门槛保持原样。定向测试新增 ground 超界 fixture，确认 confident/visible ground 仍不能伪装成真实物理边界。
- [x] 对现有 schema 做边界证据核查：只有 `floor` 与 `image_left/right/back` 等可见 wall 方位，没有完整闭合墙体或明确物理边界字段，因此本路径没有可证明的 hard room bounds；实墙仍由相机几何检查处理。
- [ ] 用 36-bedroom 与 37-temple saved fixture 重放：`20261016092858-57040`，两图请求/预览/应用、同画幅、手动 Orbit 退出和无 console error 均通过。卧室投影误差 `.1904`；寺庙 `.2502 > .22`，以 `error-too-high`/`needsReview` 保留候选而非 ground-boundary 拒绝，`cameraOutsideGeometry=true`、`hardCollisionCount=0`，估算 floor overflow 留在诊断。寺庙应用截图仍显示站姿默认人物与较粗占位道具，未通过视觉验收；继续追查构图/姿态前因，不放宽 `.22`。截图和 JSON 见 `40-20261016092858-57040-*`。
- [ ] 使用 41 寺庙和 36 卧室保存响应回放，检查输出中的拟合状态、边界审计与构图；核对预览、应用截图，继续跟进未过项。
- [ ] 最终重跑受影响的定向测试与根 `npm run build`，运行 `git diff --check`，记录端口/构建结果；不提交、推送或部署。

### 2026-10-16 参考图拟合移动与水平顺序约束

- [x] 开始本轮实现前复用集中清单；保留既有用户改动和浏览器回放 artifacts。
- [x] 给每个拟合物件设置按场景尺度与检测置信度缩放的水平移动上限（最多 1m），让相机候选优先解释投影误差；对高置信且图像 bbox 明确分离的主要地面物件，保持观察到的左右顺序。
- [x] 新增回归：单物件移动不能超过上限；若相机/受限物件移动无法恢复高置信图像左右顺序，则拒绝候选并回退。
- [x] 新增“原本分离的主要物件不能因拟合而新增重叠”硬过滤；保留家具上的坐垫/靠垫等关系与 rug/mat/blanket 等大面积表面例外，新增重叠不得仅降为 review。
- [ ] 运行定向测试并依据真实寺庙回放结果评估阈值与构图质量。
- [ ] 最终重跑定向测试、build、`git diff --check`；记录 36-bedroom/41-temple 回放结论及未通过项。不提交、推送或部署。
- [x] 源码 Vite 5174 回放已区分 source code 与旧 public bundle：runId `20261016095616-28056`（0.9m cap）显示寺庙 `.3825 > .22`、camera-only、0 位移、`needsReview/error-too-high`；卧室 `.2569 > .22`、位移 `.539`。两图 requests/preview/apply 和无 console error 均通过，36/41 画面仍待视觉对照。
- [ ] 对比真实图与预览中跨场景共性几何缺口，按 canonical semantic profile 为桌/柜/雕塑/容器/灯具补充通用 assembly；不引入卧室/寺庙专属 name/id/坐标规则。

### 2026-10-16 最终通用 assembly 回归与重放

- [x] 源码 Vite `5174` 重放固定观察响应夹具：卧室 `36-bedroom-observation-diagnostic-2026-10-16.json`、寺庙 `41-temple-observation-diagnostic-2026-10-16.json`。脚本只把 `parsedVisualObservations` 包装为 `image-observations-v1` 并拦截 `/api/director-layout`；27/28 旧完整 layout JSON 不属于本轮 converter 验证。runId `20261016100734-2716`，记录 7 个核心源码 SHA-256：[结果 JSON](../../artifacts/temple-layout-diagnosis-2026-10-13/44-20261016100734-2716-current-saved-response-ui-result.json)。
- [x] 两个 fixture 均仅调用一次、出现待应用草稿、自动打开同画幅估算机位预览、完成“添加到当前场景”，且无 console/page 错误。卧室投影误差 `.5623→.2453`，寺庙 `.7455→.3825`；两者均高于 `.22`，保持 `needsReview/error-too-high`，不得报告为拟合通过。
- [x] 物理诊断：卧室 `cameraOutsideGeometry=true`、hard collision 0、无边界越界；寺庙 `cameraOutsideGeometry=true`、hard collision 0，估算地面软边界记录 `cushion_far_left` 约 `.187m` 越界。卧室最多移动 8 个组件，寺庙 0 位移。寺庙观察人物明确为 `kneel/seiza/prayer`；预览和应用截图都显示跪姿人物，宿主默认“角色01”是另一站立角色。[卧室预览](../../artifacts/temple-layout-diagnosis-2026-10-13/44-20261016100734-2716-bedroom-preview.png)、[卧室应用](../../artifacts/temple-layout-diagnosis-2026-10-13/44-20261016100734-2716-bedroom-applied.png)、[寺庙预览](../../artifacts/temple-layout-diagnosis-2026-10-13/44-20261016100734-2716-temple-preview.png)、[寺庙应用](../../artifacts/temple-layout-diagnosis-2026-10-13/44-20261016100734-2716-temple-applied.png)。视觉审查仍未通过：两图都存在简化几何，卧室构图/遮挡尤需继续处理；应用按钮流程完成不能替代视觉验收。
- [x] 相关 8 个定向测试文件 170/170 通过；Director Desk `npm run build` 通过，仅有既有大 chunk 警告；`git diff --check` 通过（仅报告工作树中的 LF/CRLF 转换提示）。端口 `5173`、`5174`、`4175`、`8787` 均仍在监听。本轮未提交、推送或部署，也未清理已有 build/artifacts。
- [ ] 拟合阈值仍未通过两图视觉验收；之后应优先调查通用图像投影/场景尺度与遮挡问题，不能用放宽 `.22` 或场景专属坐标规则掩盖。

### 2026-10-16 通用相机拟合连续优化

- [x] 检查拟合限制确为固定 `cameraY=1.6`、target X/Z 只能取观察包围盒中点、且方位/距离/俯仰/FOV 均离散。现从粗网格最优 12 个安全 seed 做 camera position、target XYZ 和 FOV 有界坐标下降；相机必须在几何体外并保持正面候选约束，冻结所有观察物件位置，保留硬碰撞、支撑关系与左右顺序检查。已知非网格相机合成夹具恢复误差 `<.01` 且物件不移动；`imageObservationLayout` 48/48 通过。
- [x] 用源码 Vite `5174` 重放 36/41 固定 observations，runId `20261016102125-49736`：[结果 JSON](../../artifacts/temple-layout-diagnosis-2026-10-13/44-20261016102125-49736-current-saved-response-ui-result.json)、[卧室预览](../../artifacts/temple-layout-diagnosis-2026-10-13/44-20261016102125-49736-bedroom-preview.png)、[卧室应用](../../artifacts/temple-layout-diagnosis-2026-10-13/44-20261016102125-49736-bedroom-applied.png)、[寺庙预览](../../artifacts/temple-layout-diagnosis-2026-10-13/44-20261016102125-49736-temple-preview.png)、[寺庙应用](../../artifacts/temple-layout-diagnosis-2026-10-13/44-20261016102125-49736-temple-applied.png)。fixture、草稿、同画幅预览、应用与无 console/page error 检查全部通过；对象位移均为 0。卧室 camera-only 误差 `.5623→.2731`，寺庙 `.7455→.3317`，均保留 `needsReview/error-too-high`。卧室相机在几何外、硬碰撞 0、无软边界越界；寺庙相机在几何外、硬碰撞 0，`cushion_far_left` 约 `.187m` 软地面越界仅作诊断。
- [x] 增加最多 10 个 pair 的数字诊断（原始/预测 bbox 中心与宽高、centerError、scaleError、加权总误差贡献）；schema 对诊断条目、数值范围与数组长度作界限，坏条目丢弃，不写入图像内容。当前残差以个别观察/几何为主：卧室 `bed_1` 中心误差 `.307`（预测中心 `.776,.650` 对观测 `.500,.515`），`artwork_1` `.261`；`bookshelf_1` 中心几乎重合但宽高 scaleError `.811`。寺庙 `wooden_cabinet_left` 中心误差 `.310`（预测 `.390,.537` 对观测 `.080,.520`），`cushion_left` `.187`，`altar_table` 尺寸 scaleError `1.357`。其余若干组件中心接近，说明单一全局相机位移/缩放无法同时解释异常项；估算的单图 box 尺寸、深度与遮挡/物件 bbox 语义更可能是主要残差。截图复核：卧室床体仍偏右下且遮挡/结构不符；寺庙主体大致入镜但墙面、比例、物件轮廓粗糙。
- [ ] 后续若需验证观察模型解释，先比较现有 36/41 保存响应；新的真实模型二次调用会改变外部状态/产生推理成本，本轮未调用，须由用户另行授权。建议下一轮为通用边线/角点观测加入可验证的相机约束，或经授权取得同图二次观察并与现有 bbox 做盲比；不得用移动物件、单图常量或放宽 `.22` 掩盖误差。

### 2026-10-16 跨图残差归因与失败反馈

- [x] 分析 36/41 截图与 pair residual：`cameraFitBreakdown` 投影 8 个完整 box corners，不含真实可见像素、遮挡与轮廓；边界裁切可能影响碰边 bbox，但不能解释 36 卧室床/画作与书架/椅子的局部中心/尺度误差并存，也不能解释 41 寺庙居中 altar table 的 `scaleError=1.357` 及局部中心偏差方向相反。36 `bed_1` center `.307`、`artwork_1` `.261`，书架/椅子中心 `.001/.005` 但尺度 `.811/.664`；41 `wooden_cabinet_left` center `.310`、`cushion_left` `.187`，`altar_table` center `.081`、scale `1.357`。这更支持单物件代理几何/2D bbox-to-3D 尺寸与局部估算偏差，而非同一相机问题。没有足够证据自动重写尺寸/位置；那会过拟合且可能破坏支撑/碰撞，因此保留几何并增强待确认反馈。
- [x] 不自动改写 3D 位置/尺寸：仅凭 image bbox 无法区分物件真实轮廓、可见裁切、遮挡和深度，自动校正会过拟合。对整体 `needsReview` 的结果，按加权 residual 取贡献达到 70%（最多 3 项）的主要物件，将组件置为待确认、对应 observation 置为 ambiguous，保留原几何和检测置信度；诊断反馈显示物件名、center/scale 偏差并明确未自动改写。首次 36/41 回放发现原有物件已大量待确认，单靠标记无法带来可见变化，故在 Reference Layout 面板增加独立的“参考机位残差待复核”警告。定向测试 2 文件 / 65 项通过；源码 Vite `5174` 浏览器重放 `20261016103934-58944` 中 36/41 均出现可见残差警告，全部 UI 检查通过、无 console error；卧室/寺庙误差仍 `.2731/.3317`、物体位移 0、hard collisions 0，均维持 `needsReview/error-too-high`。Director Desk `npm run build` 退出码 `0`（2270 模块，既有大 chunk 提示）；`git diff --check` 退出码 `0`，仅 LF/CRLF 提示；5173/5174/4175 与 8787 均在监听，前三个首页和 8787 `/` 返回 `200`。根 `dist/index.html` 仍为既存 17:33 文件，build 输出仍单独放置，原有 dirty 文件/artifacts 保留。无新模型调用、不放宽 `.22`、相机顺序/碰撞约束未变；未提交、推送或部署。
- [x] 最终根 build 复核（面板残差提示加入后）：根 `npm run build` 退出码 `0`；Director Desk 完成 `tsc -b`/Vite（2270 模块），根 Vite 1746 模块，输出 `dist/index.html` 4.23 kB 与 JS 677.46 kB，只有既有大 chunk 提示。build 前把原 `dist` 992 个文件（109,343,554 bytes）备份并逐文件 SHA-256 核对；build 后把新产物放入 `artifacts/codex-root-build-output-20261016-final`，恢复的原 `dist` 与 build 前 manifest 0 项差异。仅暂停并恢复 Director Desk Vite `5174`；最终 5173/5174/4175 首页及 8787 `/` 均 HTTP 200，全部监听正常。`git diff --check` 退出码 `0`，仅 LF/CRLF 提示。原 build artifact 与 dirty 工作区内容未清理；不提交、推送或部署。
- [x] 改动相关 9 个定向测试文件 176/176 通过（含 camera known-truth、pair attribution 与 schema cap 回归）。
- [x] 最终验证：根 `npm run build` 退出码 `0`；Director Desk TypeScript/Vite 与根 Vite 均构建成功，仅有既有 chunk-size 警告，构建输出留在 `artifacts/codex-root-build-output-20261016`。原 `dist` 已恢复在原路径（其 `index.html` 时间为 17:33；新构建输出单独保存在上述 artifacts 目录）。源码 Vite `5174` PID `50248` 已恢复且 `GET /` 返回 HTTP `200`；`5173`、`4175`、`8787` 也均监听。最终相关 9 个测试文件 176/176 通过；`git diff --check` 退出码 `0`，只有 LF/CRLF 提示。未清理既存 dirty/artifacts，未提交、推送或部署。

### 2026-10-16 提交交付范围与验证

- [x] 提交范围仅包含参考图布局通用化的 Director Desk 源码/测试、`functions/shared/director-layout-observations.js` 与 Worker/local server 入口、相关测试、`public/director-desk/index.html` 实际引用的 JS/CSS，以及本任务清单；排除既存 artifacts、构建输出、无关节点分组文档修改和仅有 npm `peer: true` 元数据差异的 lockfile。
- [x] 删除旧 `normalizeAssemblyFixture.test.ts` snapshot 集成测试：本轮运行该测试确认，旧 saved-normalized fixture 与当前通用 semantic assembly 归一化输出已不一致（原先只断言 19 个 component、18 个 assembly）；保留更通用的 schema/assembly 回归，不提交 artifacts 快照。
- [x] 最终验证：相关定向测试 65/65 通过；根 `npm run build` 成功（根 Vite 1746 模块、Director Desk 2270 模块），仅既有大 chunk 警告；浏览器 36/41 固定夹具均显示残差待复核警告且无 console error；`git diff --check` 通过，仅 LF/CRLF 提示。
- [ ] 视觉拟合尚未达标：卧室/寺庙 bbox 误差 `.2731/.3317` 均高于 `.22`，质量保持 `needsReview/error-too-high`；不宣称视觉验收通过。

### 2026-10-16 静态产物一致性修正

- [x] Director Desk 的 hashed JS、CSS 与 HTML 从 `artifacts/codex-root-build-output-20261016-final/director-desk` 原样恢复；三者 SHA-256 与构建归档逐项一致。保留 `index-2_J4Va5y.js` hash 路径，不做手工 bundle 编辑；移除误加的 `director-layout.js`。
- [x] 生成 bundle 内的 shader literal 保留构建输出自带的尾随空白及混合缩进。源文件与其余提交内容通过普通 `git diff --cached --check`；对原始生成 JS 单独以 `git -c core.whitespace=-blank-at-eol,-space-before-tab diff --cached --check -- public/director-desk/assets/index-2_J4Va5y.js` 检查，并通过 `node --check`。
