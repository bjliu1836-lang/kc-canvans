# 在线布景生成错误调查（2026-10-22）

## 状态

生产问题已调查；根据用户补充的错误详情，失败类别可定位为V1图像观察JSON语法解析失败，无法再定位具体语法错误或是否截断。本轮已完成可离线验证的本地改进，未提交、推送或部署；未发起模型调用。线上仍运行旧V1前后端。Workers 历史遥测查询返回403，未启用新日志收集或改动线上设置。

## 线上事实与边界

- https://kc-canvans.bjliu1836.workers.dev 当前 Worker deployment status 为 55d04cd4-c5da-4bd6-9baa-4914ac0495db，创建于 2026-10-21T07:28:18.855Z，100%流量。其版本早于V2功能提交，但这只能证明部署落后，不能单独证明此次报错原因。
- 官方 Workers Scripts GET /accounts/{account}/workers/scripts/kc-canvans/content/v2 返回HTTP 200。精确multipart与解析后的module及SHA manifest保存在 artifacts/unified-multiview-layout-contract-2026-10-21/production-investigation-2026-10-22/；主module SHA-256 30aba90b2c13968d13ab6cee118f575cf20cfe0edca87b412c7ad3f6c0400801。
- 当前公开 /director-desk/ bundle index-Cycf1ekd.js 返回HTTP 200，SHA-256 eea78fe93c5c992afa406c4a4445fe0f36ac40645c56f4e99fdef5b8fd335b04。它发往 /api/director-layout 的请求明确为 outputFormat: image-observations-v1，最多3张，并发送 role: primary/supplementary；不含V2格式。bundle副本在同一artifact目录。
- Worker module中有两条不同路径，不能混为一谈：
  - 正常图像观察路径只接受V1 outputFormat，使用DIRECTOR_LAYOUT_OBSERVATION_MAX_COMPLETION_TOKENS（默认常量8192；空间复核另用最多32768），JSON payload未设置response_format: json_object。模型输出解析/合同失败分别以DIRECTOR_LAYOUT_MODEL_JSON_INVALID或DIRECTOR_LAYOUT_MODEL_SCHEMA_INVALID返回422，并带provider finish reason、model、prompt hash、issues/issuePaths。
  - 未带图像观察format的legacy草稿路径才使用DIRECTOR_LAYOUT_MAX_COMPLETION_TOKENS || MIMO_DIRECTOR_LAYOUT_MAX_COMPLETION_TOKENS || 6144，最多两次draft解析/校验；失败返回DIRECTOR_LAYOUT_INVALID_MODEL_JSON（502）。公开bundle的实际请求带V1 format，不应仅凭报错文案认定此次走了legacy分支。
- 前端把DIRECTOR_LAYOUT_INVALID_MODEL_JSON、DIRECTOR_LAYOUT_MODEL_JSON_INVALID和DIRECTOR_LAYOUT_MODEL_SCHEMA_INVALID都显示为同一通用文案。仅凭“图片模型未能返回可用的布景结构”不能区分语法JSON错误、严格字段校验失败或legacy草稿兼容校验失败。
- 用户随后补充该次提示括号内详情为“图像观察json无效”。这与线上正常V1 observation解析器在 `JSON.parse` 失败时产生的“图像观察 JSON 无效”类别相符；因此可判断本次失败发生在语法解析阶段、尚未进入schema验证或3D转换。由于当前历史telemetry不可读且没有provider finish reason，仍无法判断是JSON语法错误还是输出截断，也不能证明缺失JSON mode就是本次请求的直接成因。
- 现有Workers Observability query按官方契约只读尝试一次（events，最近30分钟，limit 20），HTTP403；未重复尝试。此次OAuth请求未获准访问历史telemetry；没有取得本次请求ID/finishReason/promptHash。
- 既往冻结V1 malformed输出 third-call-malformed-provider-choice0.txt SHA-256 8b28fa5a458c764ff3c65097784ff86aaa4f688b0bc863613a11588ece8c73c3，由当前共享V1 parser离线重放为kind=model-json、图像观察 JSON 无效。这只证明历史样本可触发JSON parse错误，不是用户这次请求的证据。

## 本地修复

- 补齐V2 system prompt里parser可接受的字段shape/枚举/上限，增加覆盖surface/item/person局部观察、接触点、轮廓、遮挡、方向、landmarks、axes的完整JSON样例，并由shared parser测试确认该样例合法。没有放宽parser，也没有改场景/空间解算阈值。
- 客户端针对malformed JSON、V2 schema错误、legacy草稿兼容校验失败、输出截断、服务端格式不兼容给出不同中文说明。安全诊断保存HTTP状态、请求格式、响应格式（仅实际返回时）、provider finish reason/model/prompt hash、output shape及受限issues/issuePaths；不记录token、图片字节或provider原始正文。
- 线上正常observation分支未设置 `response_format: {type:"json_object"}` 是已核实的代码风险；本地源码中此前已有JSON mode修复，但当前线上Worker仍为旧版本。本轮没有推送或部署，因此不能将该风险修复宣称为线上已经生效或本次错误已经解决。

## 验证

- node --test tests/director-layout-multiview-v2-contract.test.mjs：7/7通过。
- Director Desk referenceLayoutClient.test.ts + layoutDiagnostics.test.ts：30/30通过。
- `ReferenceLayoutPanel.test.tsx`：24/24通过；显式TypeScript检查与隔离root build也已通过，详情见下。
- 显式 `npx tsc --noEmit`：通过（exit 0）。Node/Worker/V2合同组合测试：45/45通过，覆盖正常观察输出、V2截断拒绝、JSON解析失败与安全诊断等路径。对应日志：`production-investigation-2026-10-22/director-desk-tsc.txt`、`node-worker-layout-contract-tests.txt`。
- 客户端/诊断/Panel回归：54/54通过（含Panel完整24项）。此前独立套件汇总分别为ReferenceLayoutClient+layoutDiagnostics 30/30、Panel 24/24。日志：`production-investigation-2026-10-22/director-desk-targeted-tests.txt`。
- 精确隔离源目录执行根目录标准 `npm run build`：exit 0，其中micro `npm ci`在隔离实体node_modules完成，Director Desk构建与根Vite构建均成功。日志和新输出位于 `production-investigation-2026-10-22/isolated-root-build/`；此前release快照及主工作区 `public/` 未用于构建目标。
- 本地5175真实UI按钮链mock错误回放：脚本exit 0，1次 `/api/director-layout` 请求，`image-observations-v2`、1张图；模拟HTTP 422 `DIRECTOR_LAYOUT_MODEL_SCHEMA_INVALID` 后，页面显示“图片模型返回的JSON未通过图像观察结构校验（图像观察对象无效）”，诊断保留 `$.views[0].entities[0].bbox:invalid`、finish reason、model与prompt hash；没有暂存预览草稿，provider调用数0。证据JSON/截图为本目录 `production-investigation-2026-10-22/browser-mock-schema-error.json` 与 `.png`。CDP `pageErrors` 收到两个404资源日志及预期的422资源失败日志；脚本未单独断言没有Runtime.exceptionThrown，不能据此写“无页面错误”。
- 最终已核实5175仍由PID 28968监听，原public构建产物和主工作区依赖未被隔离构建触碰；既有dirty均保留，Git index为空。

## 未验证

本次真实请求的具体非法JSON片段及是否截断仍无法定位；V2 prompt改进不能被宣称解决当前线上V1报错。未做真实VLM复测、部署、收费调用或空间精度/mesh穿插验证。
