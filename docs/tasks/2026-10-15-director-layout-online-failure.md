# 导演台线上参考图识别报错排查

创建：2026-10-15

状态：已发布并在线核验
范围：定位主画布内嵌导演台点击“生成”后显示“图片模型未能返回可用的布景结构，请重试或更换参考图”的真实线上触发原因；对照线上前端资源与 Worker 版本；在不读取或暴露密钥、不绕过认证、不伪造供应商结果的前提下，取得最小真实请求或日志证据，并做窄修复与验收。

## 验收口径

- 确认浏览器实际加载的导演台资源版本与线上 `/api/director-layout` Worker 路由。
- 精确关联 UI 错误到 HTTP 状态、error code 与后端处理分支。
- 获取真实线上失败证据；fixture/mock 仅用于回归，不作为线上模型恢复证明。
- 若证据支持本地可修复，保持客户端、Worker 与 local server 契约一致，添加可复现回归；执行必要测试与构建。
- 若需要部署，先向主代理提供具体目标、补丁与命令等待复核；保留 `--keep-vars`，不改密钥/配置，不盲部署。

## 进度

- [x] T00 建立任务清单，核实仓库与既存工作树。
  - 证据：仓库根 `D:/无限画布kc/tapnow-base`，HEAD `d712bc4d381858f83f60360cca7250404ff5a663`；既存修改 `docs/节点分组功能清单.md` 和 `artifacts/temple-layout-diagnosis-2026-10-13/` 未触碰。
- [x] T01 关联 UI 错误与 API 的确切 code/status、解析与 validator 分支。
  - 证据：`referenceLayoutClient.ts` 将 `DIRECTOR_LAYOUT_INVALID_MODEL_JSON` 映射成截图文案；Worker 与 local server 两次模型尝试后统一返回 HTTP 502、`issues` 与该 error code。解析支持 JSON 字符串/Markdown fence，但没有 `finish_reason=length` 处理；HTTP 502 后客户端丢弃后端 `issues`。模型 JSON 的 assembly/门窗依附/支撑引用等字段校验错误也会进入相同的整场重试与 generic 失败。
  - 输出预算：Worker prompt 请求 `max_completion_tokens` 默认 6144；普通超时重试缩为 2048；每次结构无效触发一整次同图片调用和校验纠正。外部真实 finish_reason 尚未取得，不能据此确认截断为根因。
- [x] T02 核验当前线上 HTML/JS 哈希与 Worker 生产版本、路由可达性。
  - 证据：生产 `/director-desk/` HTTP 200，引用 JS `index-BeTx0JBS.js` 与 CSS `index-Dg2cOTVD.css`；生产 JS SHA256 `2437A0D1939F9236147992C364B50598521A044220F40B470EB68C5843A3CF13` 与本地同名 build 完全一致。只读 Wrangler 部署历史显示生产最新 100% 版本为 `2638b355-6a1c-4632-917e-c587427243d5`，创建时间 `2026-10-15T09:08:56.612Z`。生产 `/api/director-layout` 未认证 POST 返回 HTTP 401 `UNAUTHORIZED`，证明接口存在及鉴权启用；不代表模型请求成功。
- [x] T03 取得一个经授权的真实供应商请求结果；区分原图缺失与样例证据。
  - 初始证据：使用仓库 `artifacts/temple-layout-diagnosis-2026-10-13/reference-temple.png` 完成 1 次真实请求（`deepseek-flash`，HTTP 200、`finish_reason=stop`、2845 completion tokens、22 组件/1 人物）；该样例不能证明用户那次失败。
  - 补充证据：之后定位到 `C:/Users/liubijie/Desktop/角色资产图/20260522-111255.jpg` 并经现有 Worker handler 完成 1 次真实供应商调用（密钥仅在内存使用；不输出密钥、图片 base64 或完整响应）。真实模型 `deepseek-flash` HTTP 200、`finish_reason=stop`、1684 completion tokens；JSON 有效，21 组件、0 人物。原包只保存在 `%TEMP%/director-layout-online-probe/bedroom-supplier-response.json`，脱敏几何摘要在同目录 summary。原 handler 对同一响应返回 502、`DIRECTOR_LAYOUT_INVALID_MODEL_JSON`，唯一 issue 是第 7 个组件门未依附。
- [x] T04 按证据实施最小修复，添加可复现回归并即时记录。
  - Worker、local server 与客户端的门窗附墙检查现按墙体 X/Z 长轴、门窗朝向和竖直范围判断；实现计算错误（墙长轴沿 Z、门 yaw=墙 yaw+90°）得到修复。确实未附墙的开口保留原坐标并标记 `uncertain`/待确认，不再阻断整场草稿；坐标、类型、assembly 等真正结构错误仍会失败。客户端门洞墙段切分同步支持 Z 长轴。卧室脱敏几何已写入 Worker/客户端回归，不含 JPG/base64/key/原始模型包。
  - 同一保存的真实供应商原包分别重放到旧 HEAD 与修复后 Worker handler：旧版 HTTP 502、issue“第 7 个组件的门未依附任何墙面”；修复后 HTTP 200、21 组件，门 [-3,0,0.9] / [0.9,2.05,0.08] / yaw 90° 原样保留且 `uncertain=false`。local server 用相同原包重放也 HTTP 200；没有额外供应商调用。
- [x] T05 完成本地针对性验证并向主代理提交发布复核信息。
  - 验证：Worker 测试 18/18、导演台定向 Vitest 34/34、`node --check server/server.mjs`、`git diff --check` 和 `npm run build` 全通过。构建更新导演台入口至新 bundle `index-BuX--Qzn.js`；`npx wrangler deploy --dry-run --keep-vars` 成功，上传包 83.16 KiB。
  - 发布流程核实：仓库无 `.github/` 或其他 CI workflow，故按授权向 `origin/main` 推送后执行单次 `npx wrangler deploy --keep-vars`，复用已通过构建产物；Wrangler 成功上传入口 HTML 与新前端 assets，无配置变更。
  - 交付：代码提交 `ce20b80efa5958561a54dca8b0cb95e0f292c0b3` 已推至 `origin/main`。Cloudflare Worker `kc-canvans` 当前 100% 版本 `680be0bf-c3db-4db7-897b-c962e7032a0e`（2026-10-15 09:50:05 UTC）；上一版 `2638b355-6a1c-4632-917e-c587427243d5` 是回退目标。
  - 线上核验：`/director-desk/` HTTP 200，引用 `/director-desk/assets/index-BuX--Qzn.js` 与 `index-Dg2cOTVD.css`。JS HTTP 200，SHA256 `D3EB95F6C8A3234DBC329BCACAD3209C9FCB3EECA2E9B9F3690D34253F7C7227`，含 invalid-layout code 与安全中文提示。匿名 POST `/api/director-layout` 仍 HTTP 401 `UNAUTHORIZED`；未绕过认证或调用生产模型。线上用户真实点击生成的成功状态尚待用户用同图复试；本地保存的同一真实供应商原包新 handler 重放为 HTTP 200。

## 外部能力边界

识别使用现有图片理解模型配置。禁止打印/改写凭据、绕过认证、调用新付费模型或伪造供应商返回。HTTP 401 只能证明路由鉴权，不证明模型可用；fixture 成功不能证明线上识别恢复。
