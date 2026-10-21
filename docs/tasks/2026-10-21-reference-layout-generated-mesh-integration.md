# 参考图布景中的按对象生成与替换 3D 模型

状态：实现完成，待主代理最终复核；当前仅冻结 API/既有 GLB 回放，不触发新 provider/GPU，不提交、不推送、不部署。本记录承接 [单物体图片生成 GLB 接入](2026-10-20-online-image-to-3d-integration.md)：已有能力只覆盖“单图→单体 GLB→模型库预览/手动导入”，本任务将其接入参考图粗布景的可编辑对象草稿，不把整房照片直接送入单物体 TRELLIS。

## 已核实的现状与边界

- `ReferenceLayoutPanel.generateLayout()` 调用 `requestReferenceLayout(selectedImage)`，后者将整张选定图片发给 `/api/director-layout`，取得 `visualObservations` 后调用 `normalizeImageObservation()` 与 `imageObservationToLayoutDraft()`。该路径完成场景语义、尺度/关系求解和程序几何草稿，不生成新 mesh。
- `ImageObservationItem` 目前有 normalized `bbox`、可选 `visibleBbox`/`completeBbox`、`visibility`、`occludesIds` 等观察字段，但没有实例 mask、透明 cutout 或可直接作为模型输入的对象像素；`LayoutDraftComponent` 也不保留源图框。矩形裁剪可能混入相邻对象、遮挡物或背景，不能标成已分割对象。
- 草稿预览在 `SceneRoot` 以 `resolveLayoutComponentRepresentation()` 在安全目录模型与程序几何间选择；未命中目录模型的对象当前始终走 `LayoutComponentGeometry`。用户确认后 `ReferenceLayoutPanel.applyDraft()` 调用 store `applyLayoutDraft()`，`buildLayoutBatch()`生成场景对象；只有已存在的 layout catalog 路径会解析并设置 `assetRefId`。
- 独立图片转 3D 流程在模型库 `AssetImportPanel`，`/api/image-to-3d/jobs` 接受一个图片文件并以服务访问码创建异步单体任务。预览用实际 GLB，确认导入会 `readLocalModelFile()`；`addImportedAsset({ addToScene: false })` 可以将模型注册为本地持久资产而不额外创建场景对象。项目对象已有 `assetRefId`，SceneRoot 正式对象可加载 ImportedModel；组件尺寸/底部居中 unit-box 适配需由预览和应用共用同一表示路径。
- 本机成功的 TRELLIS 样本仍为 needsReview（偏宽、底边残片、材质偏暗）。整房照片不能直接当单物体输入；模型生成失败、裁剪不纯或关联不确定时必须保留程序几何并显示待确认，不能用 GLB 替换空间关系推断。

## 候选最小实现与验收

1. 草稿对象保留源图 bbox 与可见/遮挡证据的客户端字段，不写进 director-layout API 新合同或持久场景语义。无可靠观察框时不开放按对象生成。
2. 仅在参考图草稿的可生成实体组件行提供“生成模型”入口，复用现有图片任务 client、访问码、capability、状态轮询、重试和 GLB preview；人/墙/地面及 `partOfComponentId` 子件不替换成单 mesh。该批只支持独立根对象；若根含复合 assembly/可见 part 后代，显示明确原因和替代输入/对象选择建议，不丢失其原观察或支撑关系。
3. 使用观察框生成矩形裁剪候选，先展示裁剪结果供用户确认；提示裁剪不是实例分割且模型可能包含背景/遮挡。支持用户上传独立单物体参考图替代自动 crop，尤其源框缺失/不可靠或严重遮挡时。无有效 crop 且未上传替代图时保留程序几何，绝不将整张房间图当作单体输入。
4. 生成成功后先通过现有 `readLocalModelFile()` 存入 IndexedDB，再 `addImportedAsset(addToScene:false)` 取得持久 `assetRefId`；只绑定当前 component ID。对象位置、rotation、估算size由 LayoutDraft 保持，网格按共同的 uniform contained normalization 适配，不逐轴拉伸；draft preview、逐项应用和“全部应用”都使用该关联资产。未绑定、失败、取消、重试中的组件仍渲染程序几何，其他组件不受影响。
5. 单项应用/全部应用均验证 component ID 到 DirectorObject `layoutSource.componentId`、assetRefId 稳定；失败后重试不重复生成/覆盖已绑定资产；刷新后 IndexedDB GLB仍能预览和加载。相同对象预览与应用检查真实 mesh bounds、`matrixWorld`、position/rotation/scale一致。复合组件继续程序几何；风险对象显示 needsReview。
6. 使用本地 mock 与现有真实 GLB fixture 验证任务→草稿对象绑定→预览→应用→刷新，不新增 provider 调用。检查普通独立物件、遮挡/assembly对象、失败重试、逐项及全部应用，以及已有目录模型与程序几何路径无回归。整房多对象自动分割和多图共享对象融合不纳入本批。

## 分步记录

- [x] 只读核对当前 HEAD=`e73ac3a22368540dd2534b0e7295979c292b2fde` 且 `origin/main` 相同；工作区有先前 tracked/untracked dirty，全部保留。适用说明：仓库根 `AGENTS.md` 与 `micro-apps/director-desk/UPSTREAM.md`。
- [x] 追踪入口、观察、草稿、预览、应用和单物体任务链路；确认无对象 mask/分割输入合同。
- [x] 主代理复核：单物体生成范围、明确crop确认与独立物件图fallback、本地资产而非server cap持久化、uniform contained fit、异步结果按draft/source/component身份绑定。复合根及parts不在本批自动替换。
- [x] 实现按组件生成、裁剪确认、单项 asset 绑定及草稿预览/应用共用表示；失败或 GLB 加载失败时保留程序几何。
- [x] 定向测试和本地 mock 浏览器验证任务→草稿对象绑定→预览→应用→刷新；未调用新 provider/GPU，mock create 仅一次。
- [x] 真实 `geometry_0` 的 preview/apply `matrixWorld` 与 world bbox 最大误差均为 `0`；meshCount=1，无程序 fallback mesh、无重复 origin 对象。前一轮 clean-source 浏览器手势完成手动 scale 后刷新，transform 与资产绑定持久。
- [x] 相关 3 个定向测试文件 135/135 通过；先前完整相关集 194/194 和 TypeScript 检查通过。最后 UI 窄改后再次跑 135 项。
- [x] 在干净 HEAD `e73ac3a22368540dd2534b0e7295979c292b2fde` 整理并验证 feature-only 源码；不包含其他 dirty、旧 `public` 资产、`package-lock` 或 `directorStore.test.ts` 的既有 catalog 期望修改。本任务尚未提交、推送或部署。

## 关键代码位置

- `micro-apps/director-desk/src/editor/panels/ReferenceLayoutPanel.tsx`：生成 `420` 行附近；草稿逐组件列表 `821` 行附近；应用 `570` 行附近。
- `micro-apps/director-desk/src/editor/io/referenceLayoutClient.ts`：参考图请求 `132` 行附近；图像观察归一化与 draft 转换 `210-212` 行附近。
- `micro-apps/director-desk/src/editor/schema/imageObservationLayout.ts`：`ImageObservationItem` `85` 行附近；`imageObservationToLayoutDraft()` `2535` 行附近。
- `micro-apps/director-desk/src/editor/schema/layoutDraft.ts`：`LayoutDraftComponent` `174` 行附近；`buildLayoutBatch()` `1794` 行附近。
- `micro-apps/director-desk/src/editor/schema/layoutComponentRepresentation.ts`、`editor/canvas/SceneRoot.tsx`：草稿与场景 mesh 表示/加载。
- `micro-apps/director-desk/src/editor/loaders/localModelImport.ts`、`editor/loaders/localAssetBinaryStorage.ts`、`editor/store/directorStore.ts`：GLB 本地持久化与 `assetRefId`。
- `micro-apps/director-desk/src/editor/panels/AssetImportPanel.tsx`、`editor/io/imageTo3dClient.ts`、`worker/imageTo3dJob.js`：现有单物体任务、访问控制、任务状态与资产读取；不另建一套服务。

## 本轮浏览器回执

- 隔离服务使用 Vite `5177`，脚本结束时关闭；用户既有 `5175` 未触碰。API 使用冻结 layout response 和既有真实椅子 GLB 做 mock job/asset 回放，provider/GPU 调用数为 `0`。
- 输入 `source-livingroom.jpg` 尺寸 `1774×887`；用户确认从原图裁剪 `[x=1282,y=468,w=434,h=279]`，之后才创建 mock 任务，未将整张房间图作为单体输入。
- 目标独立对象 `brown leather armchair`（component `armchair`），position `[2.07,0,-0.12560526315789544]`、yaw `35°`、size `[1.26,1.62,0.567]`。生成 GLB `1,735,512` bytes，SHA256 `0997402e97dde98a762f7ddf822c98840f74fed9bf348de1eb6da868ea372c6e`。
- 草稿预览和应用在干净构建浏览器中采到同一 `geometry_0`，每个目标 meshCount=1，world bounds 相同：min `[1.466304919884632,≈0,-0.6666867222327761]`，max `[2.673695080115367,0.3688403683657375,0.4154761959169852]；matrixWorld 和 bounds 最大差值均 `0`。
- 刷新后截图肉眼可见真实 GLB；localStorage 的对象/componentId/assetRefId/fit target/transform 均保留，IndexedDB 中同一 asset 二进制存在且为 `1,735,512` bytes、MIME `model/gltf-binary`。干净 production-bundle smoke 的 20 秒目标 mesh bounds 采集未返回快照，所以该轮刷新只记作视觉、元数据与字节验证通过，不宣称刷新阶段 world-bounds 数值验收通过。前一轮 clean-source开发服务器手势已单独验证手动 scale 从 `[1.26,1.62,0.567]` 改为 `[1.449,1.4904,0.61236]` 并刷新保留；这轮静态build smoke不重复scale。
- 截图和收据：`artifacts/reference-layout-generated-model-2026-10-21/reference-layout-generated-room-preview-adopted.png`、`reference-layout-generated-room-applied.png`、`reference-layout-generated-room-reloaded.png`、`reference-layout-generated-room-browser-receipt.json`。`reference-layout-generated-room-preview.png` 是采用前独立结果预览，不作为替换成功证据。
- 干净副本的定向 Vitest `194/194` 通过，完整 root build（含 `tsc -b`、director-desk Vite build、root Vite build）通过；仅有 Vite bundle 大小警告。静态 production-bundle smoke 的唯一 `503` 是脚本有意模拟空间复核接口失败：`/api/director-layout`、`application/json`；它不是模型资产请求。该轮复核接口失败被记录，`pageErrors=0`。
- 本地 TRELLIS 椅仍 `needsReview`（偏宽、底边残片、材质偏暗）；本轮只证明接入与几何/变换一致，不证明单体质量或整房空间重建准确。模拟 spatial-review 返回 503 并记录为 console error；pageErrors=0。
