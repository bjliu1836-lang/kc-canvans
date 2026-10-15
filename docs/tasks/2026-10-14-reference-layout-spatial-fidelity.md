# 参考图空间还原优化任务清单

创建：2026-10-14

状态：已完成
范围：3D 导演台的参考图识别、草稿预览和确认应用链路。目标是让可编辑的空间结构、视角和外观更接近参考图；不调用新的外部付费模型或部署。用户于 2026-10-15 另行授权将本轮相关改动提交并推送到 `origin/main`。

## 验收口径

- 参考图草稿采用统一的世界坐标、底部中心与接地语义；旧草稿可继续读取。
- 房间围护、门窗依附和物件支撑/邻近关系在客户端与 Worker 校验，并给出可纠正的诊断。
- 草稿保存参考相机；预览与应用后场景可用该机位作同画幅对照，不把原图贴作三维背景。
- 外观提示持久化且在 SceneRoot 中实际渲染；常见物件有可辨识的程序化几何。
- 本地 catalog 只匹配已验证类别；应用时将 catalog 项物化为项目 Asset 后再写 `assetRefId`，不能误把 catalog ID 当项目 asset ID。
- 草稿预览默认不为每个未选中组件绘制 Edges；确认后对象与草稿使用同一份空间/外观语义。
- 寺庙 fixture 完成识别→预览→应用→保存重开浏览器验收，并保存本地前后对照说明；不得声称已完成 image-to-3D 精细模型生成。

## 进度

- [x] T00 建立集中任务清单目录与本任务初版。
  - 证据：`docs/tasks/README.md` 和本文件。
- [x] T01 统一 LayoutDraft 的底部中心、世界坐标、尺度锚点与关系校验；兼容旧草稿。
  - 实现：仅识别 `wall`/`pillar` 的“Y=自身高度一半且无支撑”旧版中心语义，转换为场景地面底部中心；不依据 ground 的负 Y 改动其他物件。门窗未贴墙在客户端标记待确认，Worker 则把它作为一次纠正请求的结构错误。
  - 验证：`npm test -- --run src/editor/schema/layoutDraft.test.ts`（25/25）；`node --test tests/worker-director-layout.test.mjs`（14/14）。
- [x] T02 增加并持久化 referenceCamera，预览/应用提供参考机位对照。
  - 实现：模型相机无效或缺失时显式退化为 `bounds-fallback` 自动取景；缩放草稿同步缩放相机位置与目标。LayoutDraft 的 position 表示参考图镜头视点；预览直接消费该视点，应用通过现有 view→camera-rig 逆转换保存导演台相机，并在替换检查中用相同转换判断用户是否编辑过。预览可退出，应用后进入新建参考相机取景；旧相机与运镜数据不改。
  - 验证：客户端回归覆盖 lens position `[0,2.1,10]`、target `[0,1.2,-2.8]`、FOV 48 经 camera rig 往返后不变；浏览器 R3F preview/apply 实测 position、quaternion、fov 48、aspect 1.72043、projectionMatrix 一致到浮点精度。首版暴露预览遗漏既有 camera frustum depth offset，已按字段语义修正。
- [x] T03 增加外观、材质、语义方向字段，并在 SceneRoot 实际呈现。
  - 实现：`modelDescriptor`、`appearance.color/roughness/metalness/frontDirectionDegrees` 经 Worker、local server 与客户端规范化；草稿编辑、批次 `layoutSource` 与项目对象均保留。局部 +Z 正面优先驱动预览和正式对象的旋转，材质参数被 SceneRoot 的程序构件消费。
  - 验证：`layoutDraft.test.ts` 覆盖 JSON → batch object 的字段与 90° 正面方向；同轮定向测试通过。
- [x] T04 增加受限 catalog 匹配与“catalog 项 → project asset → object.assetRefId”应用链路。
  - 实现：仅对已有内置沙发、餐桌、冰箱、洗衣机做保守匹配；`applyLayoutDraft` 先物化 `DirectorAssetRef(assetSource: library)`，再写对象 `assetRefId`，catalog id 永不直接作为 asset id。无匹配类别继续使用诚实的程序构件。
  - 验证：`directorStore.test.ts` 覆盖沙发从 catalog → 项目 asset → object.assetRefId。
- [x] T05 以程序化非对称构件替代常见类别的纯 box/cylinder，并简化草稿 Edges。
  - 实现：草稿与正式对象共用 `LayoutComponentGeometry`；table/chair/sofa/cabinet 使用桌腿、椅背、扶手、柜门等受控构件。草稿只有 hover、selected 或待确认组件绘制 Edges，避免每项均生成边线。
  - 验证：`SceneRoot.test.tsx` 覆盖交互预览和受限 Edges；同轮定向测试通过。
- [x] T05b 为关键物品加入受限声明式 assembly；预览与应用同源消费。
  - [x] T05b.1 客户端 schema、批次持久化和 `LayoutComponentGeometry` 支持最多 24 个归一化 box/cylinder/sphere/cone/torus 子件；无任意代码执行。
  - [x] T05b.2 Worker 与 local server prompt/validator 同步 Euler ±360° 与旋转后 AABB 校验；空、超限、越界 assembly 触发诊断。
    - 验证：`node --test tests/worker-director-layout.test.mjs`（16/16），覆盖合法 45° assembly 直接通过，以及旋转后越界时一次纠正后成功。
  - [x] T05b.3 人工增强寺庙 assembly fixture 的浏览器 preview/apply 回归。
    - 验证：客户端真实 UI 请求路径用本地 fixture 响应驱动，调用生产 normalizer；19 组件、1 人物、18 assembly parts、19 个 visible 组件均进入 preview/apply。normalizer 回归测试现只读对比已保存结果，不再重写 artifact。截图：`artifacts/temple-layout-diagnosis-2026-10-13/12-temple-assembly-preview-2026-10-15.png`、`13-temple-assembly-applied-2026-10-15.png`、`14-normalized-preview-2026-10-15.png`、`15-normalized-applied-2026-10-15.png`。
- [x] T06 补充单元测试与 Worker 结构/关系校验测试，执行构建和 diff 检查。
  - 验证：本轮定向 layoutDraft、SceneRoot 与只读 fixture 测试合计 72/72；Worker 校验 16/16；根 `npm run build` 退出码 0（Director Desk `tsc -b` + 两个 Vite build）。最终 `git diff --check` 通过。
- [x] T07a 浏览器验收寺庙 fixture 的生产 normalizer、预览与应用同机位衔接。
  - 验证：人工增强 fixture 通过 browser UI 流程；真实 R3F 读数中预览与应用后的 position、quaternion、FOV、aspect 与 projection matrix 一致到浮点精度。截图：`artifacts/temple-layout-diagnosis-2026-10-13/20-final-reference-preview-2026-10-15.png`、`21-final-reference-applied-2026-10-15.png`。真实供应商识别不属于该 fixture 验收。
- [x] T07b 在隔离导演台编辑对象并保存重开，核对外观、assembly、referenceCamera 与已有相机运镜；保存前后对照证据。
  - 实现：草稿应用时将 `appearance.color` 写入对象当前可编辑 `color`；SceneRoot 对正式对象和导入模型都消费对象颜色，roughness/metalness 仍取 `layoutSource.appearance`，assembly 继续保留并渲染。
  - 验证：隔离 `desk_3` 将主供桌 X 改为 1.35、颜色改为 `#C28A52`，reload 后输入值和画面颜色均保留；对象 assembly 5 parts、batch `referenceCamera`、`cam_1` 两个运镜关键帧及位置/目标/FOV 与编辑前一致。截图：`artifacts/temple-layout-diagnosis-2026-10-13/22-altar-edited-before-reload-2026-10-15.png`、`artifacts/temple-layout-diagnosis-2026-10-13/24-altar-color-rendered-after-reopen-2026-10-15.png`。
- [x] T08 按用户授权审阅提交范围、提交本轮改动、使用 `git push origin HEAD:main` 推送并验证远程 `main` 指向推送提交；保留不相关脏改动。
  - 交付核对：功能提交 `d7615d17eada372146d6744b7064fd1e63cb04be`（`feat(director-layout): improve reference layout fidelity`，31 个文件）由 `git push origin HEAD:main` 成功推送；推送后 `git ls-remote origin refs/heads/main` 与该提交一致。用户既存 `docs/节点分组功能清单.md` 保持未暂存；其余未提交验收图均为本轮本地中间证据。最终仓库交付 HEAD 以最终报告核验值为准。

## 外部能力边界

- 当前内置 Guo 资产是本地 FBX，覆盖少量桌椅、沙发、柜体、酒吧环境等；没有通用床、书柜、寺庙佛像/供器高精资产，不能作为完整写实还原库。
- 主体物件 image-to-3D 是不属于本轮 JSON 自动布景主线的可选扩展；若未来需要，再另行接入经授权的提供方并评估凭据、成本与质量。本轮只验证 JSON 草稿、受限几何/assembly 与可编辑场景，不声称完成 image-to-3D 精细模型生成。
- 本轮真实供应商新 prompt 识别曾返回 401，未完成 live provider 验收；隔离 fixture 的客户端流程仍独立验证，不将 fixture 结果表述为实时模型识别。
- 本次不上传图片到新的提供者，也不改云端密钥或服务配置。
