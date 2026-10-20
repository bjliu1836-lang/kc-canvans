# 参考图空间重建垂直链路

## 范围与验收

- [x] 只读核验现有观察合同、几何归一化、支撑/碰撞、客厅与回归素材；保护既有 dirty worktree。
- [x] 扩展可选2D空间证据合同：多个可见/推断接触点、可见轮廓范围、遮挡顺序、线段及方向置信度；旧bbox数据继续兼容。
- [x] 实现解析透视/地面投影和带置信边界的候选相机恢复；退化或仅部分可校准时保留候选与 needsReview。
- [x] 联合有限搜索相机、地面XZ、宽深比例；加入尺度弱先验、重投影、接地、支撑、遮挡和碰撞目标。不得任意缩放、抬高、裁切或移相机掩盖冲突。
- [x] 共享实际多部件占地语义用于地面支撑、预览/应用与碰撞；地毯不决定家具足迹，软体不充当刚性平面；对L形/多段家具保留足迹部件。
- [x] 用已知真实相机和网格生成合成真值反例；对冻结客厅、卧室、寺庙和现有UI路径回归。明确哪些冻结观测缺少新证据。
- [x] 每小项完成即在此更新证据；完成定向测试、类型检查、隔离根构建及必要浏览器对照；保护 public 入口/assets 与 lockfile。

## 外部能力与约束

- 本项实际授权最初上限为两次上游调用；根因确认后主代理明确授权再追加一次真实客厅 spatial-review 验证，总上限3次：误用卧室、正确客厅 coarse observation、客厅 spatial review。不得重试。复用本地 route 和现存密钥，不输出密钥/值、不改线上配置。
- 若模型调用失败，可单独用人工观察标注验证，不得称为模型输出或真实模型改善。
- 不安装 Blender/MCP，不提交、推送、部署，不覆盖/清理已有 dirty 文件或证据。
- 单张图的绝对尺度有歧义；没有有效透视线或主点/焦距退化时必须保留保守fallback与不确定性。

## 进展

- [x] 核对仓库规则、UPSTREAM与旧交接；确认 master/origin/main，工作树含大量既有修改，远端为 `bjliu1836-lang/kc-canvans`；未修改/清理既有内容。
- [x] 核对当前事实：`imageObservationLayout.ts` 以6×6米常量和bbox底边线性放置；`fitReferenceScene`只调相机；`partOfId`会折叠子件但未生成父件多段实际占地。
- [x] 保存任务启动时基线：micro `src` 与 `functions/shared/director-layout-observations.js` 来自已验hash的 `build-snapshot-root-layout-overlap-v1`；以原converter导出客厅主观察/DeepSeek/D、卧室、寺庙五份完整draft。五份均兼容成功（组件数28/24/25/17/21；寺庙1人物），导出工具与hash在 `artifacts/reference-spatial-reconstruction-2026-10-19/`。
- [x] 校正卧室基线来源：旧35观察fixture及手填1.5与用于UI对照的卧室源图不是同一case。现在使用36诊断fixture、同一源图SHA与真实尺寸1024×1535（aspect 0.6671009772）仅重导卧室before，25组件；旧17组件draft留作legacy。fixture、源图、converter及输出hash见 `before/bedroom-baseline-provenance.json`；客厅/寺庙draft未重跑。
- [x] 空间证据合同/prompt/parser可选字段与三轴VP/地面投影模块已接入；Worker mock实际捕获共享system prompt SHA256、`geometryEvidence`、`groundFootprints`、8192 token预算与单次provider调用，无自动重试；Worker测试29/29。
- [x] 受约束联合求解及实际占地（解析相机候选、墙地一致性、footprint回投与安全筛选均有诊断；保守回退与needsReview保留）。
- [x] 合成真值与冻结素材回归、隔离构建及浏览器验证；真实客厅仍视觉未通过，见阶段结果。

### 本次增量证据（2026-10-19）

- [x] bbox-only 且无显式占地/接地点/遮挡证据时仅校准相机并冻结物件几何；仍以可靠左右次序拒绝不安全候选。`imageObservationLayout.test.ts` 66/66 通过。
- [x] 新增共享观测棱柱：Three `ShapeUtils.triangulateShape` 处理凹外环/内孔，并与 box assembly 每个部件的水平投影裁剪，保留部件各自 Y 区间；旋转/Yaw box 可处理，倾斜/曲面/低置信/无 assembly 保守回退并标 uncertain。
- [x] 草稿预览、正式 apply 对象、fit 碰撞与支撑验证采用同一棱柱来源；连续碰撞按实际棱柱纵向交叠与水平 SAT 计算。ground-cover/rug support 不再约束其它家具中心。
- [x] 合成单测覆盖 L 形凹口、封闭孔洞、开放桌底；新增 observation parser→converter→buildLayoutBatch apply 真值，确认 preview/apply 棱柱相同；新增桌面内孔拒绝支撑。
- [x] 定向验证：`layoutGeometryBounds.test.ts`、`imageObservationLayout.test.ts`、`layoutDraft.test.ts`、`SceneRoot.test.tsx` 合计 157/157；`npx tsc --noEmit` 通过；`node --test tests/worker-director-layout.test.mjs` 29/29 通过。
- [x] 单次误用卧室请求已明确保留在 `provider-observation-after.json` / `provider-run-after.json`；它是卧室，不作为客厅证据。此前两次调用后的“不得第三次”限制已被后续明确授权取代：只允许一次正确客厅 spatial-review，总调用上限3次，仍禁止重试或第四次调用。
- [x] 客厅纠正请求前以Worker mock验证本地route payload：图像SHA256 `8401c43e...42598` 与发出数据相同，共享prompt SHA256 `f2a42b22...02039`，geometryEvidence/groundFootprints字段契约存在，8192 tokens，调用数1；证据 `livingroom-worker-payload-preflight.json`。
- [x] 以正确客厅源图（1774×887，SHA256 `8401c43e...42598`）完成唯一纠正请求：HTTP 200、请求模型配置 `deepseek-flash`、finish reason `stop`、usage 4381 tokens；16项，groundFootprint 1、support 1、其它接触/遮挡/partOf/axes 0。route不暴露实际response model，已在run摘要标为未知。原始回复和摘要为 `livingroom-provider-observation-after.json`、`livingroom-provider-run-after.json`。
- [x] 新增无已知相机/无VP的三物体合成回归；高置信可见footprint按每个候选反投影并按yaw bounds初始化XZ/宽深/归一化拓扑，preview/apply字段一致。候选数量受限，无高成本整场局部搜索；单次converter约0.5秒。客厅新转换耗时约0.5秒，footprint采用1/1且preview/apply一致，投影误差0.307>0.22，状态为`needsReview`，不能作为视觉拟合通过。新证据见 `livingroom-converter-observation-analysis-after-footprint-fix.json`；旧`livingroom-converter-observation-analysis.json`保留，记录此前footprint为0的失败版本。
- [x] 首轮局部回归曾记录客厅footprint为凸四边形（4点）、误差0.307；该结论只适用于当时coarse响应，后续唯一review提供11点中置信轮廓。旧误差使用component长方体投影，不能与实际棱柱投影误差直接比较。不能据此宣称恢复了完整沙发L形语义。
- [x] 已核验：相机候选/ground-camera联合打分、其他空间真值/冻结素材、UI smoke与隔离构建；保护public入口/assets及lockfile。证据见最终验证条目；客厅视觉验收仍未通过。

### 接续说明（2026-10-19）

- 本任务由唯一执行代理继续完成全部未勾选项；主代理仅做只读复核，不并行运行命令、改文件、浏览器或测试。接续时无需再次确认执行分工。
- 当前具体顺序：启动最新源码 Vite，以冻结客厅观察 JSON 和原图分别生成新旧转换器各自参考相机的2:1帧；隔离项目并隐藏默认角色，跑 preview→apply，切换应用后的新参考机位并核对俯视/侧视几何。13:26旧静态构建截图显示茶几落在沙发后、餐区前右，空间关系失败，不能作为通过证据。
- 按最新 all-ground 同相机修正后复测；保存源码/草稿哈希、图片和结果 JSON。随后完成五组冻结回归、真实棱柱穿透/位置及 W:D:H 数值 artifact、本地 server mock upstream（只允许已授权的第三次review，不得第四次调用）、定向测试/Worker/类型检查/隔离根构建，并核验 public 入口/assets 与 lockfile 保护哈希。
- 新增空间证据复核闭环：为route提供可选 `observationStage: "spatial-review"` 与受限基础观察/冲突ID/缺失证据摘要；review prompt仅要求基于图片复核非凸占地、空隙、遮挡/支撑及可用平行线，不带本图固定坐标或家具清单。响应仅按已知ID合并空间字段，不新增/删除/改身份；当主要物体空间证据覆盖不足**或**存在真实冲突/无安全候选时，前端最多追加一次review，同一converter再评估；无物体、无有效图像、已取消、JSON错误不触发，失败回退coarse draft并保留待复核状态。review单独使用DeepSeek thinking enabled + reasoning_effort=max，`max_completion_tokens`默认且上限32768（包含推理和最终JSON）；仅解析content，不记录或展示reasoning_content，只保留token用量、finish_reason、response model与prompt hash。首轮快速观察和8192 token合同保持不变。先mock验证，再以正确客厅图哈希做唯一真实review（总调用最多3次），并冻结结果与prompt/response模型证据。

### 阶段复核（2026-10-19，真实review冻结后）

- [x] 统一可见已采纳footprint阈值：converter/parser接受`confidence >= 0.55`时，实际棱柱、渲染与碰撞也以同一边界应用；新增0.65置信L形与默认沙发装配回归，并证明yaw旋转后实际棱柱仍落在保守AABB宽阶段范围内。
- [x] 低置信墙地对齐冲突不再整组恢复floor/walls：仅按新冲突/相机侵入逐轮回退被影响的对齐对象，优先保留floor及墙体估算；客厅smoke确认floor约8.96×4.02m与wall坐标仍处于同一反投影尺度。`tv`/`shelf_right`残余冲突继续标记needsReview，未放宽门槛。
- [x] 相机重投影目标改用共享实际观测棱柱上下顶点（与preview/apply/collision同源）；曲面/倾斜/无装配证据退回保守component bounds，pair diagnostics明确记录projectionGeometry和分开的图像宽高残差。
- [x] footprint相机候选安全筛选后，最多3个候选执行受限局部joint refine：可靠footprint的XZ与宽深及拓扑固定，仅高度可调；无可靠footprint地面物件可小范围调W/D/H，低置信位置有位移限额；每个候选重新验证顺序、支撑和硬碰撞。bbox-only整体几何冻结分支保持独立。
- [x] 离线测量记录当前review响应的coarse约1.59s、review约0.96s（优化前约10–11s）；该轮浏览器mock请求2次、真实provider 0次，raw/preview/apply均保留1个sofa footprint、11点、confidence 0.65且preview/apply一致。另有一次已授权的真实客厅review，统计见最终验证。2026-10-19 14:43阶段误差由旧component bbox下0.175的历史值改为真实棱柱投影0.226；局部目标值0.370→0.284。该状态仍为needsReview，客厅画面仍视觉未通过（茶几过大并遮盖沙发，凹口辨识不足），不能用parity、渲染成功或误差阈值替代视觉验收。
- [x] 最后一轮候选多样性与约束触边诊断后重跑冻结五组回归与数值artifact；完成定向测试、Worker、micro TypeScript、隔离root build、public入口/assets及lockfile保护校验，并记录视觉失败边界。完整仓库 Vitest/root `tsc` 会扫描巨量 artifacts 快照，Node 堆上限内无输出/OOM；不作为本次代码失败，所需定向套件均通过。

### 最终验证（2026-10-19）

- 客厅最终源码 SHA256 `8de206f5080cfdcf2e1570202fe999bd7993905f6335ab9fbee560730d2039d7`；冻结输入图 SHA256 `8401c43e12e5ea28249f5e4dd6d4cd2dc564006ce1e473c54c54e26e12442598`。
- 定向影响面测试：六套件 179/179；新增冻结五例兼容回归1/1，Worker 32/32，独立 Three.js 真值artifact 1/1，离线客厅计时1/1；micro `npx tsc --noEmit` 通过。
- 隔离完整 root build：`%TEMP%/tapnow-base-reference-spatial-isolated-build-20261019/root-build-validation.log`；排除 `.git`、`node_modules` 与既有 `artifacts`，未改共享工作树。root入口 `index.html` 与两份 lockfile 的共享/隔离 SHA256一致；工作区 `public/director-desk/index.html` 的JS/CSS目标均存在。
- 新增/更新的数值证据：`frozen-five-current-regression-20261019.json`、`synthetic-three-camera-truth-metrics-20261019.json`、`livingroom-offline-solver-performance-20261019.json`。受控真值测试会把精确 `groundCamera` 与中心接触点输入求解器，不能解读为盲相机恢复；位置RMSE 0.172→0.0162，W:D 0.367→0.264、W:H 0.302→0.0886，但D:H 0.0884→0.243有所变差，碰撞/穿透均为0。无VP独立测试仍单独保留。
- 同一冻结客厅coarse/review观察用当前solver各离线运行一次：约1.84s / 1.99s；单次计时仅作参考，review仅轻微降低误差（0.2289→0.2261），没有视觉改善。当前离线回放/浏览器mock的真实provider调用数为0；整个任务实际上游调用共3次：一次误用卧室观察、一次客厅coarse观察、一次客厅spatial review。
- 真实review记录：provider-resolved model `deepseek-flash`，`finish_reason=stop`，用时122369ms；16个对象ID保持完整一致，sofa footprint为11点、confidence 0.65。证据见`spatial-review-real-response-20261019.json`与`spatial-review-real-run-20261019.json`。
- 客厅accepted review足迹11点，raw/preview/apply一致，但真实棱柱投影误差0.2261、`needsReview`；茶几遮挡沙发且沙发凹口仍未辨识，视觉验收未通过，未放宽阈值。
- 最终收尾阶段仅新增/更新验证artifact与本任务单，没有再次修改运行源码；这不代表连续空间重建改造未改代码。该连续改造的源码/测试范围包括：`functions/api/[[path]].js`、`functions/shared/director-layout-observations.js`、`micro-apps/director-desk/src/editor/canvas/SceneRoot.tsx`、`layoutGeometryBounds.ts`、`layoutGeometryBounds.test.ts`、`micro-apps/director-desk/src/editor/io/layoutDiagnostics.ts`、`layoutDiagnostics.test.ts`、`referenceLayoutClient.ts`、`referenceLayoutClient.test.ts`、`micro-apps/director-desk/src/editor/panels/ReferenceLayoutPanel.tsx`、`ReferenceLayoutPanel.test.tsx`、`micro-apps/director-desk/src/editor/schema/directorProject.ts`、`imageObservationLayout.ts`、`imageObservationLayout.test.ts`、`layoutDraft.ts`、`layoutDraft.test.ts`、`layoutSemanticProfiles.ts`、`referenceGroundProjection.ts`、`referenceGroundProjection.test.ts`、`server/server.mjs`、`tests/worker-director-layout.test.mjs`。其中未被启动快照manifest覆盖的route/server/worker文件仅记录为项目dirty改动，不能由该manifest单独归因。
- 启动代码证据基线是`before/source-hashes.json`记录的`build-snapshot-root-layout-overlap-v1`（234个快照文件），不是干净HEAD。该manifest可确认多份文件相较启动SHA发生变化，例如`imageObservationLayout.ts`从`a5423f2d…c3670dfe`变为最终`8de206f5…d2039d7`；`ReferenceLayoutPanel.tsx`、其测试及`layoutSemanticProfiles.ts`则与启动快照SHA相同，属于快照中已有内容。`functions/api/[[path]].js`、`server/server.mjs`、`tests/worker-director-layout.test.mjs`未由该manifest覆盖，初始检查时已是dirty状态，因此不推断其相对该快照的改动时间。初始工作树还含节点分组文档、寺庙诊断文件、Director Desk lockfile等既有变更。当前348项Git状态条目包含既有源码、日志、截图和artifact，不能整体归因于本次空间改造。最终收尾没有覆盖或清理这些文件，也没有提交、推送或部署。`git diff --check`无空白错误（仅有Git的CRLF提示）。

### 通用空间求解器二次修正（用户授权，2026-10-19）

- 视觉失败触发的离线定位：使用冻结review observation及已有浏览器回放，不调用provider。首要可修复根因是候选局部优化把二维 `pair.confidence >= 0.85`误当成三维位置确定性而冻结无ground footprint物件的XZ；位置clamp又以世界原点±limit截断而非以初始位置为中心；size/position步长每轮一旦找到任何改进就过快衰减，使小预算内停在局部邻域。遮挡关系还缺少可见遮挡面积的直接约束，需验证是否能在通用投影损失中安全表达。
- 约束：可靠可见footprint继续冻结XZ和W/D及拓扑；不使用类别/实例名或客厅坐标规则；碰撞、接地、支撑与左右/遮挡证据继续硬/软门控；搜索保留显式评估预算和每物件的证据/移动界限；不放宽needsReview，不增加真实provider调用。
- [ ] 修复相对初始位置的delta clamp，并让位置自由度由空间证据而非bbox语义置信度决定；补诊断和回归。
- [ ] 将局部搜索改为有限多尺度坐标优化，在统一投影/空间/碰撞目标下探索耦合的位置与尺寸；可靠footprint与bbox-only冻结合同不变。
- [ ] 用冻结客厅review离线分析投影、碰撞和遮挡；必要时补通用遮挡投影损失，比较preview/apply一致性及三视角浏览器画面。
- [ ] 运行必要定向测试、micro TypeScript、隔离root build；只暂存本连续空间任务代码与必需证据，审查差异后提交并推送。
