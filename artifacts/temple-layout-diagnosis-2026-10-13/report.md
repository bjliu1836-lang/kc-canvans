# 寺庙参考图粗布景诊断报告

## 结论

同一张寺庙参考图的这个单样本已识别出本轮最关键的语义：柱子、佛像与供器、跪坐真人、合十手势和台面支撑高度。当前样本更支持“合同和适配器曾是主要瓶颈”，没有证据支持仅凭旧结果立即换模型。

当前样本仍暴露一个独立合同执行问题：部分 `wall` 和 `ground` 的 Y 使用了几何中心语义，而产品合同规定 `position` 是底面中心。最终 prompt 已加入 3 米落地墙 `position.y=0`、不得填写 `1.5` 的明确反例，同时保留窗和桌面道具的悬空高度。为避免重复付费，本轮没有再次调用模型；因此该最后一条 prompt 改动只有静态测试覆盖，没有新的模型样本证明。

## 人工观察关系

- 画面是寺庙/佛堂室内，后墙供桌上有佛像和供器，左侧有立柱和木格窗。
- 真人位于坐垫上，双腿收在臀下，属于 `seiza` 跪坐；双手明确合十，应与下肢姿态分开表达。
- 佛像是场景道具，不是真人角色。
- 香炉、花瓶和烛台位于桌面或台面上，底面 Y 应等于承载台面高度。
- 人物背对默认机位，面朝后墙方向；当前坐标与角度没有验证其精确注视佛像。

## 两次服务响应

### 旧服务基线

`old-service-response.json` 来自持续运行的 `127.0.0.1:8787`。进程 PID 42128，启动时间为 2026-10-12 17:25:48，早于提交 `0942838`（2026-10-13 16:15:13）和本轮未提交实现。

该响应有 13 个组件，类别只有 `cabinet/ground/sofa/wall/window`，没有 `characters` 字段，也没有 `pillar/prop`。这只能说明旧进程使用的旧代码链路表现不足，不能归因于当前 prompt 或 DeepSeek 本身。

usage：prompt 1259、completion 943、total 2202。

### 当前代码可核验样本

`current-prompt-response.json` 来自临时端口 `127.0.0.1:8788`，使用当时工作区 `server/server.mjs`。临时服务已停止。该次实际测试的 system prompt SHA256 为：

`03d2f384408486e7f686a2e6cadbf51f8566151b56fb058ab841daa1a8dd342f`

响应包含 19 个组件和 1 个真人：

- 立柱为 `pillar`。
- 佛像为 `prop`，没有进入 `characters`。
- 香炉、花瓶和烛台为台面 `prop`，保留了非零支撑高度。
- 真人为 `posture=kneel`、`kneelVariant=seiza`、`handGesture=prayer`。
- 真人 `rotationYDegrees=180`，说明其面朝后墙方向。人物坐标 `(-0.6, 0.2)` 与佛像坐标 `(1.8, -3.6)` 的水平连线角约 148°，因此没有证据说人物精确注视佛像。

usage：prompt 2463、completion 2366、total 4829。

本地 `.env` 实际模型 ID 是 `deepseek-flash`。用户在线填写的原文是 `deppseek-flash`；当前没有核验线上 alias/provider 映射，不能宣称二者相同，也没有替用户修改线上配置。

## 底面坐标问题

当前样本中：

- `ground_01.position.y=-0.05`，高度 `0.1`；
- 两面 3 米高的墙 `position.y=1.5`；
- `window_left_01.position.y=1.6`；
- `pillar_01.position.y=0`。
- `prop_cushion_01.position.y=0.06`、高度 `0.12`，按底面合同顶面应为 `0.18`，但人物支撑 Y 为 `0.12`，两者相差 `0.06` 米。

前两类值显示模型把部分结构的 Y 当成几何中心。现有客户端预览会把组件 mesh 再向上偏移半个局部高度，因此 3 米墙从 Y=1.5 开始，实际被抬高。窗的非零 Y 本身合理，不能把所有组件统一贴地。

最终未调用 prompt 在原合同后增加逐项检查：落地 `wall/pillar` 使用地面高度，3 米墙写 `position.y=0`；`window` 和桌面 `prop` 继续使用真实支撑面高度。它还新增可选 `supportComponentId`，仅允许引用可确认的水平承载组件；引用需存在、不能自引或成环，且 XZ 足迹必须重叠。坐姿若只识别到含椅背的整个 chair/sofa，则不把包围盒顶面当座面。

最终 prompt 的新底面反例和 `supportComponentId` 合同均尚无新模型样本验证。最终 prompt SHA256 为：

`f41aac54157208a756314d9aa70ab5cd7f8051bc78c9dfc35e45a72edc06131b`

## 证据边界

- 响应文件是本地 `/api/director-layout` 返回值。服务端已完成供应商文本中的 JSON 提取和结构校验；它不是包含 HTTP headers、供应商 request ID 等字段的原始网络包。
- 单张图的成功样本说明合同类别和姿态表达有效，不证明模型在所有图片上稳定。
- 当前样本只识别出一根柱子和三块坐垫；背景柱和前景边缘坐垫仍有遗漏。
- `ground` 的 `12×10` 米尺寸是视觉估算，没有尺度实测依据。
- 人物 `rotationYDegrees=180` 只表示面朝后墙方向。人物与佛像水平连线约 148°，不能称为精确注视佛像。
- `supportComponentId` 关系和最终 Y 反例没有新的收费模型样本验证。
- 线上 `deppseek-flash` 与本地 `deepseek-flash` 的 alias/provider 映射没有核验。
- 最终新增的底面 Y 反例尚未进行收费模型复测。
- 实现已提交并推送为 `040f972`；本轮未手动部署。提交后只读检查线上静态页仍引用旧的 `index-DlHpCaSF.js` / `index-D6k4eHnQ.css`，当前 Worker 版本仍为 `df733013-7243-41d3-bfb3-466a72484c07`（2026-10-13 08:16:33Z），说明线上尚未自动更新。

## 验证

- Worker 测试：14/14 通过。
- Director Desk 定向测试：6 个测试文件，74/74 通过；新增断言直接检查成人膝骨 142° 不再被 90° 静默夹紧、其他关节与 compact 体型仍沿用原限制，旧 `sit` 90° 保持不变。真实 GLB 骨架位置回归同时约束双膝靠近支撑面、骨盆靠近双脚。
- Director Desk 子项目构建：通过。
- 根 `npm run build`：通过。
- Chrome headless 真实浏览器 smoke：16 项全部通过，fixture API 仅调用 1 次，无 console error。覆盖参考图点击和 Enter 打开、Escape/关闭按钮/遮罩关闭、Tab 焦点约束、关闭后焦点返回、source/scope 切换自动关闭、输入框 Delete 不误删布景、真实响应中的人物支撑偏差和墙体中心 Y 警告、`seiza/prayer` 控件值以及正式加入场景。
- 最终构建后又做了必要浏览器复核：`prop/pillar` 的已知高度输入为空且校正按钮禁用，旧 `wall` 仍预填 2.8 米；fixture API 只调用 1 次且无 console error。`05-seiza-side-pose-check.png` 临时把预览人物 yaw 从原始 180° 改成 90°，只用于无遮挡侧视检查腿部折叠，不代表模型返回的原始朝向。侧视可见双腿折回臀下；raw 未提供 `supportComponentId` 导致的坐垫顶面偏差仍保留为待确认诊断。
- 浏览器证据：`browser-result.json`、`seiza-side-check.json`；截图为 `01-reference-lightbox.png`、`02-real-response-seiza-prayer-warning.png`、`03-real-response-wall-warning.png`、`04-applied-real-response.png`、`05-seiza-side-pose-check.png`。
