# 参考图多视角布景异常诊断

状态：完成本轮有界转换修复与本地验证，尚未提交、推送或部署。四次本地 VLM 调用已达到批准上限；不再发起模型请求。合法双图响应的离线转换与原入口浏览器回放已完成，场景空间质量仍需人工复核，不能据此宣称整房还原准确。


## 范围与冻结证据

- 起始基线：HEAD / `origin/main`=`8165ffbde1ab144d71f37c2085caf4e44003f4ea`，index 为空。完整初始 tracked diff、状态和源码哈希在 `artifacts/multiview-duplicate-diagnosis-2026-10-21/baseline/`。未改动人工基线；保留主 checkout 的全部无关 dirty 和用户 5175 服务。
- 主图与斜视补图 SHA256 分别为 `4ca8a4ff1650c166c797c5791eaec8f7579cb5db07695d78762c70bb553f99d5`、`677b0049658cdd1dde03a74adcfcdb6e7fa7ee9af93c7130bae919acca863446`，均 1672x941。人工基线及不确定性见 `artifacts/bedroom-multiview-diagnosis-2026-10-20/human-observation-v1.json`（SHA256 `746b8cb7927fcf20f5f50c9393a6ca725e097629beabc495b1d63d0df862ead2`）。
- 用户异常截图 `C:/Users/liubijie/AppData/Local/Temp/codex-clipboard-f4ed9926-897d-4654-88fb-d493d03b9402.jpg`（2105x1042，SHA256 `986d101de5f1a52fcf9fed2134a0729cac4ce5c87967bc4c8126c376728f7d02`）显示床附近横向块体、床头柜显得偏高。没有与该截图匹配的用户现场draft/JSON；因此未将块体判为重复物件或特定assembly错误。
- 当前失败现场JSON无法从线上日志恢复：Worker route 不记录完整观察或转换trace；客户端诊断只在启用时写当前tab sessionStorage。Cloudflare script-settings GET=200，但没有可用的服务端观察日志记录；限定到 `kc-canvans` `/api/director-layout` 的历史查询返回403/API错误10000。403不代表没有请求，也不能恢复JSON。未读取其他用户浏览器或个人会话。

## 实际调用与结果

本轮共4次本地真实 VLM 调用，使用现有配置，没有充值或开通新服务；这可能消耗既有额度。未调用 HF/GPU。调用均为本地 Node route，路由别名为 `deepseek-flash`；不能据此推断线上 Worker 实际模型。

1. 改造前主图单图：HTTP 200，合法观察，usage 5465。
2. 改造前主图+斜视图：HTTP 422，`DIRECTOR_LAYOUT_MODEL_JSON_INVALID`，无draft。第一次安全取证脚本漏存 outputShape/finish metadata，无法细分空响应、截断或JSON格式错误。
3. 完成关系/语义三项修复、但尚未加入JSON mode时的双图尝试：HTTP 422。原 choice0 文本已恢复到 `third-call-malformed-provider-choice0.txt`，3902 bytes，SHA256 `8b28fa5a458c764ff3c65097784ff86aaa4f688b0bc863613a11588ece8c73c3`。文本在根对象闭合后继续出现 `,"items":...`，整体不是合法JSON；不手工拼接或挽救。
4. 获准的最后一次 JSON mode 双图请求：HTTP 200，provider返回一份观察；usage 4138/1317/5635。安全输出与转换样本分别保存在 `postfix-jsonmode-dual-route-response.json`、`canonical-dual-*`。不触发spatial-review或额外请求。

历史三图观察 `artifacts/reference-layout-multi-image-2026-10-21/real-vlm-observations-readable.json`（16 items/4 surfaces）仅用于离线合同分析，不冒充当前双图结果。该旧样本中床尾凳同时标 `placement=floor` 与 `supportId=bed_main`，属于另一条关系矛盾风险，不是用户两图失败现场证据。

## 诊断与修复

实际链路把选中的多张图放在同一次 provider user content 中；并非先逐图生成JSON再拼接。初始请求与spatial-review共用图组；review按已有ID patch，不允许新增对象ID或改身份字段。失败样本原文缺失，无法证明provider如何产出异常块体。

四项通用修复只影响观察→草稿链和当前视觉观察API：

1. 关系冲突：显式floor放置对象与非地面实体support的矛盾关系不参与支撑、位置和fit约束；保留原观察并标不确定。合法ground-cover及明确supported物体继续工作。
2. 已知语义身份：匹配已有semantic profile时，使用身份profile的有效几何类别；不兼容的原始category仍保留在原观察并记冲突/uncertain。未知身份继续走原category fallback。转换前先构造统一geometry view，再生成support、ground和fit maps；不重写人工/历史对象类别。
3. 关系清除合同：有界关系字段的显式`null`表示清除，省略表示保留；初始输入中的null按未提供处理。提示词区分initial与review语义。
4. JSON格式：DeepSeek `deepseek-flash` 当前 observation initial/review 请求显式使用 `response_format: {type:"json_object"}`；坏JSON仍严格拒绝，不拼接、多JSON挑选或退回单图。Node与Worker均保持完整图组。官方依据：[DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/)。

床语义例子必须分开描述：改造前旧单图记录的bed是`semanticType=bed/category=sofa`，合法双图记录是`semanticType=bed/category=table`。这是两次VLM观察输入的差异；两次prompt/JSONmode也有变化，因此不能归因于“补图单独导致”。在固定同一双图JSON的转换器对照里，旧转换受raw category影响而将bed落成通用table盒；新转换按已知bed身份使用canonical sofa类几何并保留uncertain。这是确定的转换器改进，不证明空间关系已正确。

`canonical-dual-deterministic-converter-before-after.json`记录同一成功双图观察的逐对象前后值：20对象中bed、两张床头柜和两盏灯的几何/位置改变，其余对象输出对应字段不变。bed由通用盒 `[1.74,0.75,0.70]` 变为床语义5构件表示、目标尺寸`[2,1.2,2.2]`；床头柜恢复profile尺寸`[0.5,0.55,0.4]`及7构件装配，支持它们的台灯随支撑面高度从Y=0放到Y=0.55。组件保留uncertain；draft层没有before/after needsReview字段，不据此声称字段验收。

## 验收

- 定向测试：正式schema/pipeline三套 `imageObservationLayout.test.ts`、`layoutDraft.test.ts`、`layoutDraftPipeline.test.ts` 合计125项（其中 `imageObservationLayout.test.ts` 78/78）；另有初始dirty中的 `providerObservationComparison.test.ts` 1项离线对比，合并记录为126项但不算本轮新增回归。`referenceLayoutClient.test.ts` 20/20；Worker、Node multi-image route及共享合同测试合计39/39。任务scratch comparison测试已移到artifacts，不计入正式回归。
- 本轮浏览器用原入口重放固定成功双图response，spatial-review由mock响应，不发provider请求。初始请求为一份双图请求，最终生成一份20组件draft。draft与apply对照为20/20匹配：组件position、size、yaw误差均为0，visibility及resolved assembly相同；Y俯视camera before/after相同，pageErrors=0。Receipt：`artifacts/multiview-duplicate-diagnosis-2026-10-21/canonical-dual-topdown-parity.json`；截图：`canonical-dual-topdown-draft.png`、`canonical-dual-topdown-applied.png`。
- 数值对照使用同一 `getLayoutComponentRenderPosition` / `getLayoutComponentAssembly` 规范化路径；floor/rug的Y归位差异是既有render helper行为，不是preview/apply偏差。bounds是组件代理AABB，**没有测量实际Three mesh Box3或穿插**。20项只表示本次新batch；apply默认append并保留旧对象/角色，因此不代表整场景对象集合相同，也不定位用户现场是否重复。
- 独立人工基线仍有未验收关系：bed头侧与后墙接触、床头柜相对床头深度、右侧长柜方向/占地、地毯与床尾凳关系、房间边界和绝对尺寸。当前dual bed没有可信墙面锚点；fallback坐标不是米制重建证据。保持needsReview，不通过改相机或卧室特例掩盖空间不确定性。
- 干净隔离root `npm run build`退出码0：使用 `D:\无限画布kc\release-multi-image-1be6db5`（source基底`1be6db5601cdcb6a51b0c02a5bde3d4109e983ec`，仅覆盖本轮11个源码/测试文件）；标准脚本中的Director Desk `tsc -b`、2276模块微应用Vite build及root 1746模块Vite build均成功。输出只写隔离worktree的public/dist，没有更新主checkout public。初次主checkout `tsc`把本轮生成的`compareDualConverter.before.tmp.test.ts`当测试编译；确认它和`imageObservationLayout.before.tmp.ts`均由本任务生成，已完整移至 `artifacts/multiview-duplicate-diagnosis-2026-10-21/scratch/` 并以.txt保存，未删除内容。初始dirty中的`providerObservationComparison.test.ts`原位保留。清理scratch后主checkout `npx tsc --noEmit -p tsconfig.json`退出码0。`git diff --check`通过。

## 交付范围与边界

- Task-only代码范围为11个源码/测试文件及本过程文档；任务前完整tracked diff/hash在 `baseline/`。历史dirty文件、package-lock、public构建资产、directorStore历史测试及大型artifacts不纳入本任务代码变更；保留用户工作区状态。
- 当前仍未提交、未推送、未部署。总计4次真实本地VLM调用已结束；后续验证只重放冻结响应，不再请求provider。线上Worker模型及其实际双图接收/质量未被本地调用证明。
- 不宣称修复整房质量；不能据此用户截图识别出具体重复对象。真实mesh bounds、物理接触与交叉、场景尺度和多视图标定仍待后续证据。
