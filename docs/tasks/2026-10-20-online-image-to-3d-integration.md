# 线上单物体图片生成 GLB 接入

状态：静态连接修复已推送并部署：commit `e815c416c027f352dab4e584c88bb41a9c0d31ae`，Worker Version ID `3dee18a8-e325-4a6c-a227-904879fff2bf`。第一条真实任务曾创建并终态 `failed/PROVIDER_FAILED`，尚无成功GLB。真实518图CPU-only路径已在workerd运行至GPU提交门前并主动停止。另发现并修复了创建POST pending期间过早开始status轮询的前端竞态；该小修已通过4.5秒延迟回归，待单独提交/部署。只有最终版本部署并核实后才执行一次真实GPU提交/预览导入验收。旧任务的公开status不返回provider event ID，不能仅凭其泛化错误字段直证是否到达上游；本地同代码路径复现证明connect失败发生在提交前。

## 范围与边界

- 本 MVP 仅处理单张图中的一个主体：上传、创建线上任务、查询状态、持久化 GLB、预览并确认导入导演台。
- “整房识别→多个可编辑对象/空间关系”继续走现有观察与程序布局路径；本任务不承诺把整房输入变为精确房间重建。
- Hugging Face 凭据只在服务端 secret；不进入浏览器、bundle、日志、过程文件或项目源码。
- 保留现有 `/api/director-layout` 输入输出合同和手动模型导入；不把 GLB 塞进 observations schema。
- 不采购或升级 GPU 计划；若检查到将自动收费或必须购买资源，先停止并回报。

## 当前架构审计

- [x] 基线与工作区：`HEAD=555075203c79ee1a08ad9f40f223be74452ae8e3`，`master` 跟踪 `origin/main`。工作区存在大量先前 dirty/untracked，须按文件与 hunk 保护；本任务至此未改产品源码。
- [x] 本机 HF 试验：现有 `run_authenticated_trellis_centered_once.py` 通过隔离 `gradio_client` 和 `huggingface_hub.get_token()`，用本机 HF 凭据调用 `trellis-community/TRELLIS`。修正后的输入是人工绘制的单椅 alpha mask，单图 `multiimages=[]`；约 50 秒成功生成 1.735 MB GLB。修正结果仍需人工复核：偏宽、带地面碎片。匿名尝试曾因 ZeroGPU 余量为 0 失败。已有结果是本机实验，不代表线上集成或整房还原。
- [x] 产品接口：`/api/director-layout` 目前接受单张图并返回 `visualObservations`，再转换成 `LayoutDraft`；没有 HF/TRELLIS 生成任务路由、GLB 结果合同或持久任务记录。该合同保持独立。
- [x] 导入路径：导演台已有 `.glb` 本地文件导入、浏览器本地资产保存、Three.js 渲染与刷新恢复；它接收已有文件，不会调用生成服务。
- [x] Cloudflare 配置：`wrangler.toml` 仅配置静态 assets；R2 binding 当前是注释。没有发现 Queue、D1、KV 或 Durable Object binding。现有媒体上传在无 `MEDIA_BUCKET` 时退到 Cache API `cacheOnly`，不适合持久保存生成任务和 GLB。
- [x] 凭据存在性：本机官方 HF token cache 只读检查为存在（仅输出布尔值）；Cloudflare `wrangler secret list` 只读取名字，列出 4 个现有 Director Layout secret，无 HF/TRELLIS secret。未读取或输出任何 secret 值。
- [x] Cloudflare CLI 状态：`wrangler whoami` 成功，已认证的账号身份未记录；KV 与 D1 列表为空。只读 R2 bucket list 请求失败，具体权限/服务原因未确认。
- [x] Cloudflare 资源创建：按主代理批准创建专用 KV namespace `kc-image-to-3d-assets`，ID `a9b26b87d0494485a5ecde5a8f030662`；`wrangler.toml` 配置 binding `IMAGE_TO_3D_ASSETS`。加入 SQLite Durable Object binding `IMAGE_TO_3D_JOBS` / class `ImageTo3DJob` / migration `image-to-3d-v1`，不启用 R2 或付费资源。
- [x] API 鉴权现状：生成/布局类 Worker handler 会校验 app bearer token，但部署 secret 清单没有 `LOGIN_PASSWORD`/`AUTH_SECRET`；源码在未设置时回退到固定默认值，token 的 `sub` 也是固定 `kc-user`。这是共享口令型门槛，不是强的操作者身份/按用户所有权隔离。新任务至少必须沿用 `requireAuth`，再使用随机 job capability 或其他服务端校验；同时加全局并发/次数上限。不要只靠 Origin/CORS。
- [x] `@gradio/client` 在 Cloudflare Worker runtime 的最小兼容 probe：repo 外临时安装 2.7.1，以 `esbuild platform=browser` 打包进 Wrangler 所用 Miniflare/workerd，在内存 Worker binding 注入 token，官方 `Client.connect('trellis-community/TRELLIS', {token}) + view_api()` 返回 HTTP 200，并发现 `/generate_and_extract_glb`。只验证 connect/view_api 和 Space 元数据，不发 GPU job；不能据此推断当前 ZeroGPU quota 或生成权限。
- [x] Token 生命周期只读元数据：本机凭据为带 `expires_at` 的短期 OAuth access token，当前审计有效期至 `2026-11-19 04:28:38 UTC`；代码不做OAuth刷新。上线运维需到期前通过官方本机 `get_token()` 更新 Worker `HF_TOKEN` secret；可选 `HF_TOKEN_EXPIRES_AT` 用于预检，过期映射为 `PROVIDER_AUTH_UPDATE_REQUIRED`。未读取/记录token、refresh token值。
- [x] Durable Object alarm 与 Gradio job 恢复策略：官方 SDK 的 connect/view_api 已通过。SDK `SubmitIterable` 暴露 `wait_for_id()`/`event_id()`，但没有对既有event恢复迭代的接口；实现提交前落库`submit_started`、提交回执event ID立即落库，回执未确认或进程重启后无恢复接口时状态改为`unknown`，绝不二次submit。10分钟硬截止；unknown占并发20分钟后释放服务入口（其日额度仍消耗），UI须说明远端任务可能继续执行。Alarm重入只对尚未开始submit的任务启动provider。

## 执行清单

1. [x] 记录已有生成回执、现有产品接口、导入能力、持久化和凭据缺口；保留既有实验文件不覆盖。
2. [x] 架构复核/资源：通过官方 SDK connect/view_api 握手；创建DO SQLite/alarm及KV绑定。KV仅放<=20MiB GLB二进制，任务状态在DO SQL；单图输入持久化前将按512KiB SQLite BLOB行拆块写入DO，限制总文件大小并在成功/失败/unknown后清理。报警恢复无SDK既有event恢复接口时保守置为unknown，不重发。
3. [x] 独立任务API：`POST/GET/POST cancel/GET asset` 位于 `/api/image-to-3d/jobs`；沿用bearer并额外验证运营者访问码，job/asset随机capability只持久化hash；幂等ID，单活跃任务、每日2次、20分钟unknown lease；SQLite DO chunks持久化输入/状态，KV仅放<=20MiB GLB。
4. [x] 服务端adapter与状态机：使用官方 `@gradio/client@2.7.1`，先 `/start_session` 和 `/preprocess_image`，再提交 `/generate_and_extract_glb`；固定live API 10个可见字段，hidden `is_multiimage` State保持默认false。persist submit_started/event ID，alarm超时10分钟；不确定提交不自动重发。最终文件限定Space源origin，下载时 `redirect: manual` 并拒绝3xx/跨源response，检查字节上限及GLB magic。
5. [x] 在产品可见入口 `模型库→我的模型→图片生成 3D 资产` 复用现有 `readLocalModelFile`/director store导入；同一服务端持久GLB URL用于预览和导入，刷新后保留session任务和已导入本地资产。生成UI不复用整房布局schema。
6. [x] 后端定向单测及Workerd/Miniflare SQL DO+KV路由测试；真provider仍待复核，未发起新GPU任务。
7. [x] 隔离Vite生产构建成功，不覆盖 `public/`；mock浏览器流程已跑上传→任务运行中刷新→同ID恢复→完成/GLB预览→导入→刷新后资产可见。回执与截图在下方过程记录路径。
8. [x] 将核心代码、状态分类和依赖闭包交主代理复核；候选提交需仅含本任务源/测试/文档与基于HEAD重建的root lock。旧public、artifact及其它dirty明确排除。
9. [x] `HF_TOKEN` 与 `IMAGE_TO_3D_ACCESS_KEY` 已以批准的secret流程配置；访问码保存在本机私有文件。HF账户读取结果为 `isPro=false`、`canPay=false`；未启用付费额度。
10. [x] 使用固定真实椅子GLB做本地 mock 浏览器验证：预览/应用/刷新后三阶段的实际 mesh world bounds 与 `matrixWorld` 一致；边界与回执见下方。
11. [~] 接入已部署到线上版本 `e815c416c027f352dab4e584c88bb41a9c0d31ae` / Worker Version ID `3dee18a8-e325-4a6c-a227-904879fff2bf`。旧真实任务返回 `failed/PROVIDER_FAILED`，没有GLB回执；根因静态方法this丢失已修复部署。不要重试旧任务；创建请求总数目前1，实际TRELLIS生成提交数0。下一次新任务只在全部前端修复部署后创建，实际GPU submit最多一次。
12. [x] 静态连接错误修复与状态可诊断性：Worker默认使用绑定后的`Client.connect`；状态表记录`starting-session`，终态失败保留最后有效phase并返回安全阶段错误码；UI优先显示终态与具体阶段。固定518图CPU-only workerd探针已到`onSubmitStarting`后主动拒绝生成，GPU submit为0。Worker/Miniflare测试15/15通过，状态映射、viewport导入和Director Desk TypeScript检查通过；干净release worktree的微应用/root生产构建及Wrangler dry-run成功，后续部署仍需包含新发现的轮询竞态修复。
13. [~] 修复create POST较慢时前端status轮询先于任务落库、404有界重试耗尽后不再轮询的问题：POST pending期间不启动该job GET，finally后对预存的同一capability恢复轮询；4.5秒延迟mock验证pending时GET=0、create POST=1，响应后GET读到completed。代码尚未提交/部署，不能执行真实GPU验收。

## 过程记录

- 2026-10-20：只读审计命令：`git status --short --branch`、`git rev-parse HEAD origin/main`、`rg --files`、`rg -n`；HEAD 和 origin/main 均为 `555075203c79ee1a08ad9f40f223be74452ae8e3`。
- 2026-10-20：只读检查 HF 本机 token 存在性（仅输出 `true/false`），未显示值；只读 `wrangler secret list --name kc-canvans`（仅显示 secret 名称）无 HF/TRELLIS 相关 secret。
- 2026-10-20：只读 `wrangler r2 bucket list` 失败；现阶段 R2 可用性未知。未创建资源、未写 secret、未运行真实 provider。
- 2026-10-20：`wrangler whoami` 成功（不记账号身份）；KV/D1 read-only list 无资源返回；不能据此确认创建资源权限。R2 list 失败，资源是否已有仍未确定。
- 2026-10-20：repo 外临时安装 `@gradio/client@2.7.1`，esbuild 打包后在 Miniflare/workerd 内执行官方 `Client.connect + view_api`，HF_TOKEN只作为内存 binding，不打印/落盘。返回 `HTTP 200`，包含 `/generate_and_extract_glb`，11个API输入参数、3个输出；没有调用 `submit`，GPU调用次数为0。该探针只验证SDK/Space handshake，不代表ZeroGPU任务可用或配额足够。
- 2026-10-20：按批准创建 Cloudflare KV namespace `kc-image-to-3d-assets`，Wrangler 返回 ID `a9b26b87d0494485a5ecde5a8f030662`。配置绑定为 `IMAGE_TO_3D_ASSETS`；DO binding/migration 名为 `IMAGE_TO_3D_JOBS` / `ImageTo3DJob` / `image-to-3d-v1`。未创建R2或收费资源。
- 2026-10-20：建议绑定命名及数据分工已发送主代理复核：`IMAGE_TO_3D_JOBS`→`ImageTo3DJob` SQLite DO，`IMAGE_TO_3D_ASSETS`→`kc-image-to-3d-assets` KV；尚未创建任何外部资源。
- 2026-10-20：鉴权代码检查：`functions/api/[[path]].js:67-93,877-883,1012-1015`；当前 bearer auth 可复用为第一道门，但部署 secret 名称中没有 `LOGIN_PASSWORD`/`AUTH_SECRET`，且当前固定 subject 不提供不同操作者身份。需在新昂贵生成路由加限流/并发限制，并经主代理审查登录 secret 配置动作。
- 2026-10-20：官方接入文档只读检查：Gradio JS Client 支持 `Client.connect(..., { token })`、异步 `submit`、status/data 事件及 Blob 上传；HF Spaces 文档支持检查公开 API/OpenAPI。官方参考链接：[Gradio JS Client](https://gradio.app/docs/js-client)、[HF Spaces API endpoints](https://huggingface.co/docs/hub/en/spaces-api-endpoints)。Worker 兼容性、真实 Space 授权与配额尚未验证。
- 2026-10-20：官方SDK类型/源码只读核对：`SubmitIterable`有`wait_for_id()`和`event_id()`，源码中的ID需待`/run` POST应答后才可知；SDK没有恢复已有event流的公开方法。因此新实现必须先持久化submit_started，拿到ID后立刻持久化；alarm重启或提交结果不确定时置unknown而绝不重发。
- 2026-10-20：冻结成功receipt的`view_api()`列出10个用户可见输入字段（image、multiimages、seed、两阶段guidance/steps、multiimage_algo、mesh_simplify、texture_size）；TRELLIS源码另有隐藏`is_multiimage` State，默认false。产品保持单图并使用Space官方`/preprocess_image`后再传入`generate_and_extract_glb`（其Python函数注明`preprocess_image=False`，不能跳过UI上传预处理）；初始真实单椅成功实验使用已人工透明mask并中心化的518x518图作为已预处理输入，本项目不实现另一套背景抠除算法。
- 2026-10-20：实现文件已接线：`worker/imageTo3dProvider.js`、`worker/imageTo3dJob.js`、`worker/index.js`、`functions/api/[[path]].js`、`wrangler.toml`、前端 `imageTo3dClient.ts`/`AssetImportPanel.tsx`/`GeneratedAssetPreview.tsx`/`ViewportToolbar.tsx`、测试与mock fixture。产品settings未包含mock provider开关；只有隔离测试bundle通过esbuild alias替换provider。
- 2026-10-20：真实浏览器调试先复现两处UI边界并窄修：①为恢复响应丢失而先保存session后，第一次status GET可能先于POST在DO内落库并返回404，面板以前停止轮询；现在仅对`JOB_NOT_FOUND`做有界8次×500ms GET重试，不重发任务POST。②确认导入路径漏引入既有`readLocalModelFile`，已补 import。
- 2026-10-20：mock浏览器回执 `artifacts/online-image-to-3d-integration-2026-10-20/browser-mock-receipt.json`；截图 `browser-generation-preview.png`（password访问码已遮蔽，预览为mock三角GLB）和 `browser-imported-after-reload.png`。运行中刷新前后jobId一致，创建POST一次，asset GET 200，确认导入后refresh能在“我的模型”列表看到`trellis-*`并在场景属性面板见对象。providerCalls=0；mock只证明任务/资产/导入链路，不代表HF输出质量。
- 2026-10-20：验证命令与结果：`node --test tests/worker-image-to-3d.test.mjs tests/worker-image-to-3d-miniflare.test.mjs`（此前修复后12/12；新增redirect拒绝单测后待最后一轮运行）、在`micro-apps/director-desk`执行`npx vitest run src/editor/canvas/ViewportToolbar.test.tsx`（36/36），`npx tsc --noEmit --pretty false`（exit 0），`npm run build -- --outDir D:/无限画布kc/tapnow-base/artifacts/online-image-to-3d-integration-2026-10-20/director-desk-build`（成功，未写public）。
- 待补项已收窄：主代理审查核心差异；配置服务端`HF_TOKEN`/operator secret；查询账单/额度只读状态；一次真实调用与GLB质量人工评估；隔离闭环通过后主代理审查再决定提交/部署和线上复核。整房多对象拆分和多视图融合不在MVP。

## 复核补记

- 2026-10-20：按主代理复核，TRELLIS status event 分类现覆盖 `broken=true`、`broken_connection`、`connection_error` 与 `session_not_found`，这些提交后不确定状态保持 unknown；额度不足、401/令牌拒绝、容量限制各返回安全错误码，普通函数错误仍为确定失败。原始 provider `message` 不写入状态或响应。新增 status-event 回归后 Worker/Miniflare测试13/13通过，覆盖连接中断、额度不足、401、普通函数异常与消息脱敏。
- 2026-10-20：候选 root lock 从 `HEAD:package-lock.json` 派生，只增明确的 `@gradio/client@2.7.1`、`miniflare@4.20260312.0`、`playwright-core@1.55.1`。重算统计新增55个package记录、0删除、原有package版本0变化；与工作区当前 `package-lock.json` SHA256一致（`1BFA8A2A3C1B510673AC52C360583F294B26ED3D2786B5437A7B5DE10E209E35`）。`@gradio/client`锁依赖闭包仅含自身及`fetch-event-stream`，没有命中当前npm audit漏洞项；此结论只针对该新增生产依赖闭包，不代表全仓audit无漏洞。全量root audit报告17项（1低、2中、13高、1严重），micro-app audit 9项（4中、5高）；未运行audit fix。新devDependency Miniflare仅用于Workerd测试，不被Worker入口导入。
- 2026-10-20：全新HEAD+本轮补丁隔离副本 `artifacts/online-image-to-3d-integration-2026-10-20/clean-ci-head-plus-image-to-3d` 起始无 `node_modules`/junction。root `npm ci` 成功（174 packages），microapp `npm ci` 成功（232 packages，微应用依赖未改，使用HEAD lock）；完整 `npm run build` 成功（微应用2275 modules，root1746 modules），Wrangler `deploy --dry-run` 成功（241.80KiB / gzip 61.96KiB，检查配置后`--dry-run: exiting now`）。输出位于该artifact隔离副本/目录，不写用户public和当前checkout依赖目录。重新在该副本跑Worker/Miniflare 13/13、ViewportToolbar 36/36通过。
- 2026-10-20：候选纳入清单共17个文件：`functions/api/[[path]].js`、`worker/index.js`、`worker/imageTo3dJob.js`、`worker/imageTo3dProvider.js`、`wrangler.toml`、root `package.json`/`package-lock.json`、Director Desk `imageTo3dClient.ts`/`AssetImportPanel.tsx`/`GeneratedAssetPreview.tsx`/`ViewportToolbar.tsx`/`styles/index.css`/`ViewportToolbar.test.tsx`、两个Worker测试与`tests/fixtures/image-to-3d-mock-provider.js`、本任务文档。生成后的`public/`、其它package-lock、mock截图/回执和其余历史dirty不纳入。API/Create、toolbar/styles与package文件按本轮diff hunk审查，不扩大提交范围。
- 2026-10-20：主代理复核发现初版生成预览仅 `gltf.scene.clone + Bounds`，没有走 SceneRoot 对普通导入 GLB 使用的 `NormalizedImportedObject`；自动取景会掩盖预览/应用物理尺寸差异。窄修复在 `SceneRoot.tsx` 导出该共享组件，`GeneratedAssetPreview.tsx` 将同一 `gltf.scene` 交给组件，默认沿用普通导入规范（最长边2、XZ居中、minY落地、SkeletonUtils clone及材质隔离）；不修改生成mesh，不改 layout-only unit-box 资产路径。
- 2026-10-20：真实固定 GLB 回放文件 `artifacts/image-to-3d-trellis-2026-10-20/trellis-community-authenticated-centered-chair.glb`（1,735,512 bytes；SHA256见本目录原始导入receipt）通过本地Vite+Miniflare mock 流程；providerCalls=0、创建POST=1。R3F Fiber store场景中同一 mesh `geometry_0`：预览、确认导入、刷新后bounds均为 min `[-1,0,-0.5264948788]` / max `[1,0.6849825927,0.5264948788]`；mesh `matrixWorld` 三阶段逐项一致，scale约`2.002904`、position约`[0.001300,0.341381,-0.003085]`，应用根`obj_3` rotation为零、scale为1。边界误差阈值`1e-5`。预览与场景canvas/camera不同（预览470×240、FOV38；场景1440×930、FOV50），因此只断言实际mesh世界几何矩阵/边界一致，不宣称相机取景相同。
- 2026-10-20：parity浏览器receipt `artifacts/online-image-to-3d-integration-2026-10-20/browser-mock-receipt.json`；截图 `browser-generation-preview.png` 与关闭模型库后的 `browser-imported-after-reload.png`。通过真实任务UI mock请求→GLB预览→确认导入→刷新，R3F真实mesh验证通过；不是新的HF识别/生成质量证据。本轮新增临时browser脚本仅为本地artifact，不纳入产品提交。`SceneRoot.test.tsx` 46/46通过，`npx tsc -b --pretty false`通过；仍需对clean HEAD+本轮窄patch做发布构建和部署复核。
- 2026-10-20线上失败复核：部署版本 `cbf9883`、静态入口/JS hash已按此前过程记录核验。唯一旧任务POST一次并返回202；随后同一job直接status GET为HTTP200、`state=failed`、`phase=failed`、`error=PROVIDER_FAILED`。`publicJob()`不返回providerEventId；原浏览器脚本/临时Chrome退出且未写receipt，旧capability仅存在已销毁的sessionStorage，因此没有createdAt/deadlineAt/私有status可复查。没有重发POST。
- 2026-10-20根因复现：`@gradio/client@2.7.1`官方`Client.connect()`静态方法内部执行`new this(...)`。生产adapter默认参数原为裸`connect = Client.connect`并直接`connect(...)`；workerd/Miniflare以同HF token和SDK复现安全短错`TypeError: this is not a constructor`，堆栈落在connect静态调用，阶段为`connecting`。同一Client.connect在Node运行时连接成功并发现官方预处理/生成端点；明确说明此前只有connect/view_api握手并未覆盖adapter中裸静态调用。
- 2026-10-20CPU-only正式adapter探针：`artifacts/online-image-to-3d-integration-2026-10-20/workerd-cpu-diagnostic-receipt.json`，输入为`input-armchair-model-ready-518-centered.png`（134035 bytes）。修复`Client.connect.bind(Client)`后，同版本SDK/workerd执行connect→start_session→原图上传→`/preprocess_image`→同源预处理文件下载，抵达GPU调用前的`onSubmitStarting`并由诊断回调主动返回false；结果为`phase=submitting`、`gpuGateReached=true`、`gpuSubmitAllowed=false`。该复现只覆盖CPU路径，不是新的GPU任务。
- 2026-10-20本轮窄改：`worker/imageTo3dProvider.js`绑定静态连接并在错误上附安全阶段分类；`worker/imageTo3dJob.js`持久化`starting-session`并在失败时保留最后phase；前端终态优先、阶段优先映射；Worker adapter receiver回归与DO终态phase回归。`node --test tests/worker-image-to-3d.test.mjs tests/worker-image-to-3d-miniflare.test.mjs` 15/15；`npx vitest run src/editor/panels/AssetImportPanel.test.tsx` 5/5（替换已被6cad138职责迁移淘汰的“本地导入”断言，保留在ViewportToolbar入口的本地导入验证）；ViewportToolbar对应单测1/1；`npx tsc -b --pretty false`通过。待干净副本完整构建/Worker dry-run、补丁提交部署后再进行一次真实GPU调用。
- 2026-10-20：已仅提交上述8个核定文件，commit `e815c416c027f352dab4e584c88bb41a9c0d31ae` 并推送 `origin/main`；未包含lock/public/无关dirty。清洁release worktree从该SHA检出，复用既有依赖目录的junction但绕过会运行`npm ci`的root build wrapper，直接`micro npm run build → root clean → root vite build → wrangler deploy --dry-run`成功；上传资产构建显示微应用2275 modules、root1746 modules，Worker dry-run 242.67 KiB/gzip 62.11 KiB。随后已部署该SHA，上传仅director-desk入口与新JS。该版本尚未启动新真实GPU任务。
- 2026-10-20：发布后复核发现慢create POST时`setStoredSession`会立即启动status GET，8×500ms `JOB_NOT_FOUND`重试可能在POST超过4秒时耗尽，POST 202后同ID未改变导致effect不重启。窄修新增`creatingJobId`门闩：POST发起前仍先持久化capability，但pending期间暂停GET；请求finally清除门闩，现有effect恢复轮询。`AssetImportPanel.test.tsx`延迟create 4.5秒回归6/6通过，确认pending期间GET为0，之后GET读到completed且创建请求始终一次。该修复尚未提交/构建/部署，不应在此状态触发生产任务。
