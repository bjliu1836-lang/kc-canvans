# Cloudflare Workers 自动构建锁文件故障修复（2026-10-22）

## 状态

根pnpm锁修复已提交并推送，现有Cloudflare Workers Builds自动构建成功并部署。`origin/main` 的锁修复提交为 `920fb33de0f05d5a01adf5abba83343133fa5453`；对应GitHub check `Workers Builds: kc-canvans` 以相同 `head_sha` 完成且结论为success。当前部署100%流量版本为 `27bcc0bd-cd85-4718-99b6-d6cf695f95f2`。没有手动运行Wrangler deploy，没有改Dashboard/secret，也没有调用模型。保留原有dirty工作区、public输出、依赖和5175进程。

## 证据与根因

- 用户提供的Cloudflare构建截图显示构建环境使用pnpm 10.0.0、npm 10.9.2、Node 24.21.0；安装步骤为 `pnpm install --frozen-lockfile`，错误为 `ERR_PNPM_OUTDATED_LOCKFILE`；构建步骤为 `pnpm run build`，之后由 `npx wrangler deploy` 发布。
- 截图显示最近Git提交对应的自动构建均失败，线上Worker仍是 `55d04cd4-c5da-4bd6-9baa-4914ac0495db`。此前过程文档的“推送源码不包含部署”表述不准确：GitHub push会触发已配置的Workers Builds；本问题导致安装阶段失败，因此没有新部署。
- 精确锁差异：根 `package.json` 声明 `@gradio/client@2.7.1`、`miniflare@4.20260312.0`、`playwright-core@1.55.1`，根 `pnpm-lock.yaml` 的 `.` importer均未记录。Git历史显示三个依赖由 `6cad1388554b74d4d68199202860308790570f81` 于2026-10-20加入；根pnpm锁仍停留在 `fc01aa42f9a755d2569e53b54bc2de047cdb46bd` 的早期内容。
- 导演台子应用有独立 `package-lock.json` 和npm构建脚本；该锁当前有用户既有dirty，本次不改、不暂存、不把它并入根pnpm工作区。修复应优先只更新根 `pnpm-lock.yaml`。
- Workers Scripts只读接口返回HTTP200，并确认 `kc-canvans` 的实际worker tag是 `160ec97a98c5406bbb4db8c9c54eb002`。按正确tag调用Workers Builds triggers和builds API均HTTP403；未再重试。`wrangler deployments status`在修改前读取到100%流量仍指向 `55d04cd4-c5da-4bd6-9baa-4914ac0495db`。
- GitHub CLI未安装。最初未带用户名的非交互Git credential查询未取得凭据；改用精确remote用户名 `bjliu1836-lang` 后，现有credential helper可在内存中提供GitHub API认证，未打印或保存token。GitHub checks API对旧基线 `49b9064` 返回HTTP200并确认 `Workers Builds: kc-canvans` failure；本次 `920fb33de0f05d5a01adf5abba83343133fa5453` 的check返回HTTP200、相同 `head_sha`、completed/success。Workers Builds API的正确worker-tag查询仍返回HTTP403；没有重复请求或扩大权限。
- 冻结安装失败已在干净 `git archive` HEAD隔离树中按 `corepack pnpm@10.0.0 install --frozen-lockfile`复现，退出1并列出上述三项specifier差异。
- 用pnpm 10.0.0在隔离HEAD树执行 `install --lockfile-only --ignore-scripts`更新根锁；旧190个package/snapshot条目保留，新增55个，原版本与integrity不变，唯一已有package元数据增加registry deprecation说明。
- 修复后 `CI=1 corepack pnpm@10.0.0 install --frozen-lockfile`退出0，167个依赖安装成功。pnpm提示esbuild/protobufjs/sharp/workerd依赖脚本被默认忽略；没有扩大allowlist，完整build实际验证通过。
- 隔离树 `corepack pnpm@10.0.0 run build`退出0：导演台子应用 `npm ci` 232包、tsc和Vite构建通过，根Vite build通过。实际环境Node `24.11.1`、npm `11.6.2`、pnpm `10.0.0`；相较Workers截图的Node `24.21.0`/npm `10.9.2`，Node和npm minor版本不同，最终以自动CI结果确认。
- 推送后GitHub check以精确提交SHA `920fb33de0f05d5a01adf5abba83343133fa5453` 完成success；Wrangler只读部署状态显示 `27bcc0bd-cd85-4718-99b6-d6cf695f95f2`承接100%流量，旧部署版本已替换。
- Workers脚本content/v2只读接口HTTP200；仅在内存扫描到 `image-observations-v2`、`json_object`、`parseDirectorLayoutObservationV2`标记并保存安全摘要/hash，没有落盘完整Worker源码或任何密钥。公开 `https://kc-canvans.bjliu1836.workers.dev/director-desk/` 和其JS资源均HTTP200；资源为 `/director-desk/assets/index-BFtVd5TG.js`，SHA256 `B660F1E6C34691A7A0007C3B5A396974CD7978CBDAE8418CC5A6EB1EE89217F6`，与隔离标准build产物完全一致。根bundle `/assets/index-gBKhcUhs.js`也与隔离build SHA256一致。主代理另独立确认线上bundle含V2、JSON错误/截断说明和“每张图地位相同”文案。
- 修复推送触发了现有自动Workers Builds并产生新部署；这证明锁失配阻塞已解除，但没有发起真实VLM请求，不能据此承诺实际模型对V2合同的生成质量。

## 执行清单

- [x] 读取AGENTS/UPSTREAM、Git基线/remote/dirty、两份package manifest和锁文件、忽略规则、构建/部署脚本。
- [x] 确认根锁与manifest差异、依赖引入提交和截图中的CI安装命令一致。
- [x] 在与CI相同pnpm版本和冻结模式下复现失败；在隔离HEAD快照中同步根锁。
- [x] 在隔离HEAD+补丁副本执行 `pnpm install --frozen-lockfile` 与完整 `pnpm run build`；未发现后续构建失败。
- [x] 修正既有调查文档中的自动构建/部署事实，同时保留当时读取到的线上版本作为历史快照。
- [x] 精确暂存根锁与任务文档，提交 `920fb33de0f05d5a01adf5abba83343133fa5453` 并推送到 `origin/main`，触发自动构建；未手动部署。
- [x] 用GitHub checks API确认该精确SHA的Workers Builds completed/success；用Wrangler确认新Worker版本承接100%流量；只读验证公开导演台资源与隔离build哈希一致。
- [x] 最终复核无关dirty/index、原public输出、原依赖和5175服务未被本轮改动；仅提交锁文件和两份任务文档。后续文档回执提交仅更新记录，不修改运行源码。

## 验收与边界

- pnpm 10冻结安装在干净隔离目录成功；完整根build通过。
- Cloudflare自动构建/部署状态已通过GitHub check、Wrangler部署状态和公开资源读取核验。
- 只提交必要根pnpm锁和文档；不触碰既有子应用package-lock改动、根node_modules/public、无关dirty或5175服务。
- 不做付费VLM/HF/GPU调用；不执行手工 `wrangler deploy`、不修改密钥或线上构建设置。
- 本轮未验证真实VLM返回质量、空间重建精度或模型端错误率；线上版本更新只说明自动build/deploy成功。
