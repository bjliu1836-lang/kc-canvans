# 参考图粗布景最多三张同空间输入

状态：已提交并部署。功能源码提交 `1be6db5601cdcb6a51b0c02a5bde3d4109e983ec` 已推送至 `origin/main`；Worker Version ID=`55d04cd4-c5da-4bd6-9baa-4914ac0495db`。部署来源是干净worktree的该SHA。过程文档本次部署后更新，稍后作为docs-only提交推送。改造前基线 HEAD=`3abac512b917f015a833a3c861ffe9ea020a0d7c`。开始前完整 tracked diff、index diff、status 与相关源码哈希已保存于 `artifacts/reference-layout-multi-image-2026-10-21/baseline/`；初始 index 为空，已有多项 tracked/untracked dirty 全部保留。

最终测试通过：Node/Worker/共享合同 37 项，微应用定向 42 项（最后panel单独23项），显式微应用 TypeScript 检查，隔离目录生产构建（2276 modules）及原入口浏览器三图mock。干净发布worktree中root `npm ci`、完整root `npm run build`（微应用2276 modules，root 1746 modules）与Wrangler dry-run均通过；部署新增上传Director Desk HTML/JS两资源。线上HTML读取到新hash JS：`/director-desk/assets/index-Cycf1ekd.js`，2,023,413 bytes，SHA256=`eea78fe93c5c992afa406c4a4445fe0f36ac40645c56f4e99fdef5b8fd335b04`。隔离浏览器从“新建导演台”进入线上真实ReferenceLayoutPanel，验证三图提示/上传入口/生成按钮，未触发API POST且无page error。另经主代理授权，对本地Node Director Layout route做了唯一一次真实三图initial VLM调用：配置别名与返回模型均为`deepseek-flash`，HTTP 200，usage 5925 tokens；client未调用spatial-review；provider返回一份通过schema的融合观察（16 items、4 surfaces）。本次只验证VLM收到同一三图组并能产出融合观察，不代表空间几何已标定，具体边界见下文。

## 改造前冻结现状与链路证据

- 改造前，`ReferenceLayoutPanel` 可汇总画布连接图与一张本地图，但识别只传当前 `selectedImage`。
- 改造前，`requestReferenceLayout(image)` 和空间复核请求均只发 `image:{url,fileName,sourceId}`。
- 改造前，Cloudflare `functions/api/[[path]].js` 和本地 `server/server.mjs` 都只读取 `body.image.url`，provider 请求只放一个 `image_url`，不会把补充图传给 provider。
- 图像观察 `bbox`、`groundContacts`、footprint 与 `geometryEvidence.axes` 均为 0..1 归一化图像坐标；`imageObservationToLayoutDraft()` 使用传入的主 `ReferenceLayoutImage` 设置主 source 和裁剪证据。多图合同锚定第一张主图，其余图只能提供同场景身份/遮挡/关系证据，不能将补图坐标并入主图框。
- 初始快照：`baseline/initial-tracked.diff` 25,592 bytes；`baseline/initial-index.diff` 为空；相关十个源文件 SHA256 记录于 `baseline/source-sha256.json`。

## 本轮验收清单

- [x] UI 最多选 3 张本地/画布参考图，主图顺序明确，可添加、移除、设为主图；超限不静默截断。
- [x] 单张和 2/3 张进入同一次 `/api/director-layout` 请求；Worker 与 Node provider adapter 将所有图片放在同一 user message；`spatial-review` 保留同一图组。
- [x] `images` 数组是权威输入：缺省时兼容旧 `image`；数组为空、超 3、元素非法或与 primary 顺序冲突时明确拒绝，不能退回只用第一张。
- [x] prompt 明确所有坐标只属于 primary 图；补图只辅助核对同一空间对象身份、关系、遮挡与可见性；补图独见且无法定位到主图的对象不可伪造 bbox。
- [x] draft source/crop lineage 保留主图 source identity；所有 bbox crop 仅裁主图。整组 sourceId/URL/顺序改变会使在途识别过期。
- [x] Worker 与本地 Node route 合同测试、单图兼容、最多 3 张/超限测试通过；payload mock 断言 3 个 image_url 同在单条 provider user content；浏览器从原有入口选择 3 张、识别并得到单份草稿。
- [x] 经授权完成一次本地 Node route 的真实三图 initial VLM 调用；未调用 GPU、未调用 spatial-review、未触发重试。构建和浏览器流程另用 mock provider。

## 实际三图调用记录与边界

- 配置来源是本机 `.env` 中 `MIMO_VISION_MODEL_ID=deepseek-flash`，没有设置 `DIRECTOR_LAYOUT_MODEL_ID`；本地 Node route 的实际优先级为 `MIMO_VISION_MODEL_ID || resolveMimoTextModel('2.5')`。Worker 代码优先级是 `DIRECTOR_LAYOUT_MODEL_ID || MIMO_VISION_MODEL_ID || resolveMimoTextModel('2.5')`。本结果只证明本地 route；不能据此推断线上 Worker 当前运行时覆盖值。
- 使用 `image-observations-v1` initial route、thinking disabled，三图顺序为卧室主图、同房间斜视图、从斜视图裁出的左侧窗/椅细节（第三张不是独立机位）。输入哈希、来源角色、尺寸、请求大小在 `artifacts/reference-layout-multi-image-2026-10-21/real-vlm-request-manifest.json`；响应观察与模型/用量在 `real-vlm-response.json`。无图像base64、token、凭据URL保存在 receipt。
- 调用前有两次未进入 provider 的本地 route 尝试：一次缺少本地 bearer（401），一次数组记录缺 `id`（400）；随后唯一一次有效 provider 调用为 200。总计 route 请求 3 次，provider 请求 1 次；没有自动重试。不要把前两次算作VLM推理。
- Provider 合法返回 16 个 objects、4 个 surfaces，识别出床、床尾凳、地毯、两侧床头柜、左侧椅和边几、左侧窗、右侧衣柜、卫浴开口相关空间线索等；其余细项见真实响应。`bed_main` 的基础类别 `sofa` 符合当前基础几何类别合同，床身份由 `semanticType=bed` 保留；它不构成分类错误。右侧/后墙置信度为 0.60/0.70，房间边界与真实尺寸仍未标定；本轮没有同图组单图控制，不能据此宣称多图质量提升。
- 浏览器 mock receipt 为 initial 与 spatial-review 各带 3 张，主图切换后顺序正确，生成单份草稿；`providerCalls=0`、无 page errors。截图 `browser-three-selected.png` 与 `browser-three-fused-draft.png`。
- 将上述唯一真实provider响应经浏览器拦截回放通过 `ReferenceLayoutPanel` 的同一转换与预览路径：三张原始/裁剪来源进入一份 draft，20 个组件、0 个人物；UI保留待确认/暂估状态。截图 `browser-three-real-observations-replay-draft.png`，安全回执 `browser-real-observation-replay-receipt.json`。该回放未触发真实provider调用；质量仍待人工核对，不能替代精确几何验收。
- 线上部署入口截图及回执：`online-deployed-entry.png`、`online-deployed-entry-receipt.json`。cache-buster GET获得新HTML与JS；线上VLM配置/model是否覆盖本地别名未知，本轮不外推。
- 最终两项状态边界窄修：仅当当前已选主图或补图的URL更新才会取消在途请求；图组指纹变化统一清除旧draft及`referenceCameraPreview`并回director模式。新增 panel 回归覆盖未选候选URL更新不取消请求、移除补图及已选补图URL变化均清理旧draft/机位。
- 定向结果：`node --test tests/worker-director-layout.test.mjs tests/director-layout-reference-images.test.mjs tests/server-director-layout-multi-image.test.mjs` 37/37；微应用 `npm test -- --run src/editor/io/referenceLayoutClient.test.ts src/editor/panels/ReferenceLayoutPanel.test.tsx` 42/42（panel单独23/23）；`node --max-old-space-size=8192 ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json --pretty false` 通过；最终微应用 build 输出到 artifacts 下独立 `build-boundary-final/`（2276 modules），未覆盖 `public/`。较早`build-final/`是在边界窄修前生成的，不作为最终build证据。
- 本轮没有线上真实VLM请求/图片身份验证，也没有多视角相机标定、图像配准、精确三维重建。补图只作为同场景证据，所有坐标仍在主图框架。生成资产crop也只使用主图。线上验收只确认新静态bundle与ReferenceLayoutPanel入口可见，没有线上真实三图payload或模型调用。

多视角未标定时不承诺精确空间重建。本批只让 VLM 联合观察图组并将单一融合观察投影到主图坐标；不做逐图独立识别后合并、不做相机标定/几何配准，也不把补图 bbox 当作主图 bbox。
