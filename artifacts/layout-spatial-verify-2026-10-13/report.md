# 图1参考图布景空间关系有限验证

时间：2026-10-13  
范围：只读代码核对 + 定向测试；未修改实现、未登录、未部署、未提交、未推送。

## 结论

这次没有获得新的真实模型原始输出。当前 Cloudflare OAuth 只用于 Worker 管理，不能替代应用用户认证，也不能读取远端 `DIRECTOR_LAYOUT_*` Secret 值；线上 `/api/director-layout` 需要应用 Bearer token。当前没有可安全复用的应用 token。本地 `.env` 只有 `MIMO_*`，而 `server/server.mjs` 不读取 Worker 的 `DIRECTOR_LAYOUT_*` 通道，因此没有用本地 MIMO 代替线上配置。

定向测试证明：当前解析与摆放链路不会把模型给出的家具朝向改错，也不会纠正空间关系。组件的 `position`、`size`、`rotationYDegrees` 原样进入草稿；预览和正式应用只把角度从度转换为弧度。一个“床头靠窗”的错误结果只要结构合法，就会通过服务端/客户端校验并按错误朝向显示。

定向测试未发现度/弧度转换错误；提示词和关系验收存在明确缺口，是优先排查方向。由于未取得图1真实模型原始输出，尚不能确定本例实际错误发生在哪一层。整体坐标系旋转 90° 或 180° 本身可以合法；需要验收的是床、窗、右墙、床头柜、左书柜之间的相对关系。

## 图1应保留的相对关系

- 窗位于后墙。
- 床头贴右墙，床的长轴从右墙伸向房间左侧；不能把床头改成贴后窗。
- 床头柜位于床头靠窗的一侧，仍应同时邻近床头和后墙/窗区域。
- 左书柜靠左墙，开放面朝房间内部。
- 图中没有人物。尺度不能依赖“图中一名站立成年人 1.7 米”，应回退到门高、层高、床宽/长等可见标准物。

把整组坐标同时旋转不会改变这些关系，不能仅凭某个绝对 `rotationYDegrees` 判断对错。

## 原始输出、解析与摆放对照

本轮真实模型调用：**未执行**。没有可报告的真实模型 raw JSON、usage 或模型 ID，避免把本地 MIMO 结果误写成线上 `DIRECTOR_LAYOUT_*` 结论。

为隔离链路问题，定向测试使用两组明确标为测试输入的 model-like JSON：

| 测试输入 | 客户端草稿 | 正式对象 transform | 结果 |
| --- | --- | --- | --- |
| `床(size=[1.6,0.55,2.1], rotationYDegrees=90)` | 位置、尺寸、90° 原样保留 | `rotation.y = π/2`，scale 原样 | 通过 |
| `床(size=[1.6,0.55,2.1], rotationYDegrees=0)`，语义上设为错误方向 | 位置、尺寸、0° 原样保留 | `rotation.y = 0`，scale 原样 | 仍通过 |
| `左书柜(rotationYDegrees=180)` | 180° 原样保留 | `rotation.y = π` | 通过，但 box 外观无法区分正反面 |

测试文件：`artifacts/layout-spatial-verify-2026-10-13/layout-spatial-chain.test.ts`。

## 代码证据

1. `functions/api/[[path]].js:481-505`
   - 只允许 `ground, wall, door, window, table, chair, sofa, cabinet`，没有 `bed`。
   - 只定义了 Y 向上和 `size=[宽,高,深]`，没有定义参考图到世界坐标的 X/Z 方向、家具局部长轴、正面或床头语义。
   - 只有人物的 `rotationYDegrees` 定义了面朝方向。
   - 尺度要求固定依赖站立成年人，但图1无人，没有无人图的 fallback。
2. `functions/api/[[path]].js:527-604`
   - 服务端只校验类型、有限数值、范围、id 和数量；不校验窗是否贴墙、床头是否贴正确墙、床头柜是否邻近床头、书柜正面是否朝室内。
3. `micro-apps/director-desk/src/editor/schema/layoutDraft.ts:401-474`
   - 客户端校验后原样保留 `position`、`size`、`rotationYDegrees`；只有 `carveDoorOpenings` 会按门洞拆墙。
4. `micro-apps/director-desk/src/editor/schema/layoutDraft.ts:564-590`
   - 正式应用直接执行 `rotationYDegrees * Math.PI / 180`，没有家具朝向修正。
5. `micro-apps/director-desk/src/editor/canvas/SceneRoot.tsx:1736-1755`
   - 草稿预览同样直接把角度转弧度并渲染 box/cylinder。
6. `functions/api/[[path]].js:861-900`
   - 二次模型请求只在结构校验失败时触发；空间关系错误因结构合法，不会触发修正。
7. `server/server.mjs:1119-1153`
   - 本地 server 使用 `MIMO_API_KEY/TEXT_API_KEY`、`MIMO_TEXT_ENDPOINT/TEXT_ENDPOINT`、`MIMO_VISION_MODEL_ID`，与 Worker 优先使用 `DIRECTOR_LAYOUT_*` 的配置并不等价。

## 根因分层

### P0：提示合同不足

- 没有统一世界坐标：建议明确 `+X=参考图右侧，+Y=向上，+Z=朝向参考相机，-Z=深入画面`，并明确所有对象共享这一坐标系。
- 没有局部轴合同：建议明确 box 的 local width/depth 与 yaw 的关系，例如 yaw=0 时 local width 沿 +X、local depth 沿 +Z。
- 没有家具语义方向：床需要 `headDirection`，书柜/柜体需要 `frontDirection`；仅有 `rotationYDegrees` 无法表达“床头”和“开放面”。
- 没有无人图尺度回退：建议按“门高 2.05m → 常见层高 2.7~2.9m → 标准床 1.5/1.8×2.0m → 其余物体”排序选锚点，并降低不确定项置信度。
- `bed` 缺失会迫使模型映射到 `sofa` 或 `cabinet`，但它只是限制之一，不应单独认定为唯一根因。

### P1：缺少关系级校验

在现有结构校验之后增加关系检查，并把失败原因送入现有的一次纠正请求：

- window 必须接近某一 wall 平面；
- bed 的 head endpoint 必须接近指定 head wall，长轴应大致垂直该墙；
- bedside table 必须接近 bed 的 head endpoint；
- cabinet/bookcase 必须靠墙，front direction 应指向房间内部；
- 家具应落在 ground/房间边界内，且避免明显互穿。

关系字段最好成为明确 schema，例如 `relations`、`headDirectionYDegrees`、`frontDirectionYDegrees`，不要只写在 `notes` 里。关系校验不能把某个绝对世界角当成固定答案，应允许整组刚体旋转。

关系校验需要独立从图像提取的关系或人工确认锚点；若关系与坐标同时被模型误判，几何自洽检查仍可能通过。

### P1：预览阶段暴露语义方向

对床显示“床头”标记，对书柜显示“正面”箭头，并允许用户一键旋转 90°/翻转 180°。单纯 box 在 180° 前后完全对称，即使 JSON 写了正确正面，用户也无法从当前几何外观判断；这是表达能力上限。

### P2：类别与几何表达

- 增加 `bed` 类别，并使用至少带床头板的非对称组合 primitive。
- 对书柜使用带开放面提示的非对称占位，而不是六面相同的 box。
- 若要进一步接近透视图，应恢复或估计参考相机/消失点；当前单图语义布局没有相机恢复，不能保证像素级对应。

## 测试证据

- 新增定向测试：1 个文件、2 个测试通过。它验证正确/错误家具角度都会被原样解析并转成弧度。
- 既有窄回归：`layoutDraft.test.ts` 与 `layoutDraftPipeline.test.ts` 共 24 个测试通过。
- 未运行全量构建；本任务要求查出问题即停，且没有实现改动。

