# 参考图布景中的按对象生成与替换 3D 模型

状态：代码已推送并部署；线上参考图布景入口已核验。代码提交 `c3548a60b19c057dd7b2dde95beae13946f2b88f`，Worker version `b88ded8b-c099-4a1a-84c2-48d3dac34504`。本轮未触发新 provider/GPU 任务。本文承接[单物体图片生成 GLB 接入](2026-10-20-online-image-to-3d-integration.md)：单物体生成已接入既有参考图粗布景对象草稿，但不把整房照片直接送入 TRELLIS，也不宣称整房重建完成。

## 实现与边界

- `ReferenceLayoutPanel` 的参考图粗布景流程保留图像观察、关系求解和程序几何；可生成对象的草稿行额外提供裁剪确认、独立物体图替换和单体 GLB 生成。矩形裁剪不是实例分割；用户确认前不会提交生成任务。没有可信对象图时保留简模，不使用整张房间图静默回退。
- 生成成功后通过现有本地模型导入路径将 GLB 写入 IndexedDB，再仅把 `assetRefId` 和非敏感来源标记绑定到当前草稿组件。请求 capability、服务访问码和 provider token 不写入 DirectorProject。
- 草稿预览与应用对象共用同一 GLB、本地资产解析、材质和 uniform-contained fit。fit 只做统一比例缩放，不逐轴拉伸；对象的位置、朝向和当前尺寸关系保持。应用不额外在原点插入模型，失败或资源加载失败时逐对象退回程序几何。
- 采用结果前二次检查当前 draft/source/component 指纹；生成期间用户对对象做的变换不会被旧快照覆盖。生成绑定及 frozen fit target 经草稿/项目归一化和 reload 保留。
- 独立根对象可按对象替换。具有 `partOfComponentId` 的子件、结构面、或无法安全隔离可见 part 后代的复合根不自动替换，继续显示原程序几何并保留语义/支撑关系，避免整件 GLB 与原子件叠加。该工作不包含自动分割、整房多对象生成或多图空间融合。
- TRELLIS 单椅样本仍需人工复核：模型偏宽、底边有残片、材质偏暗。本轮验收的是生成资产接入及预览/应用一致性，不是单物体质量或空间重建准确性。

## 验收与发布记录

- [x] 只读检查既有工作区并整理 feature-only patch；保留全部其他 dirty，不纳入旧 `public`、lock 或无关测试改动。
- [x] 实现草稿逐对象生成、源图裁剪确认/替换图、资产绑定、统一预览/应用表示、fallback 与持久化。
- [x] 相关完整定向测试 `194/194` 通过，TypeScript `tsc -b` 通过。干净副本 `npm run build` 成功（Director Desk 2276 modules，root 1746 modules）；`npx wrangler deploy --dry-run` 成功。构建仅有 Vite bundle 体积警告。
- [x] 本地 mock + 既有真实椅子 GLB 回放：任务→草稿绑定→预览→应用→刷新；未调用 provider/GPU。预览和应用的实际 `geometry_0` meshCount 均为 1，`matrixWorld` 与 world bounds 最大误差为 0；无 fallback mesh 或重复 origin object。对象位置 `[2.07,0,-0.12560526315789544]`、yaw `35°`、目标尺寸 `[1.26,1.62,0.567]`。GLB 为 1,735,512 bytes，SHA256 `0997402e97dde98a762f7ddf822c98840f74fed9bf348de1eb6da868ea372c6e`。
- [x] 前轮 clean-source 浏览器手势验证手动 scale 修改后 reload 保留；最终 production-bundle smoke 验证应用后 reload 截图可见真实 GLB，项目中的 `assetRefId`、fit target 与变换保留，IndexedDB 二进制仍为 1,735,512 bytes、MIME `model/gltf-binary`。production-bundle reload 的程序化 world-bounds 采集器没有在 20 秒内取得目标快照，因此 reload 阶段只记视觉、项目元数据和完整字节验证通过，不声称 reload 的数值 bounds 验收通过。
- [x] 线上 HTML 指向 `/director-desk/assets/index-D8o37VWs.js` 与 `index-xaeXmHaH.css`；JS HTTP 200，2,018,078 bytes，SHA256 `8D2DD7641EAEB73293DCD23B3A3B1DD68DEBE46D27AC5073200C12CDF42A20D2`，与干净构建产物一致且含“生成模型”入口标记。Cloudflare 线上版本为 `b88ded8b-c099-4a1a-84c2-48d3dac34504`。线上浏览器打开已有导演台，在“场景”检查器看见“参考图粗布景”、上传入口及“生成粗布景”；未上传图像或启动任务。
- [x] 正式构建 smoke 唯一 503 是脚本对 `/api/director-layout` 的预期 mock 空间复核失败响应；不是 GLB 资产请求。`pageErrors=0`。
- [x] 源码与发布部署完成；不触碰用户既有 5175 服务。

## 关键路径

- `micro-apps/director-desk/src/editor/panels/ReferenceLayoutPanel.tsx`：参考图草稿、逐对象生成器及应用。
- `micro-apps/director-desk/src/editor/panels/DraftComponentAssetGenerator.tsx`：裁剪/替代图、任务恢复、资产保存及绑定。
- `micro-apps/director-desk/src/editor/canvas/SceneRoot.tsx`：草稿/正式对象共享生成 mesh 解析、fit 与 fallback。
- `micro-apps/director-desk/src/editor/schema/imageObservationLayout.ts`、`layoutDraft.ts`、`directorProject.ts`：对象观察、生成绑定、fit 持久化。
- `micro-apps/director-desk/src/editor/io/imageTo3dClient.ts`、`editor/loaders/localModelImport.ts`、`editor/store/directorStore.ts`：既有单体任务及本地资产存储路径。

## 验收材料

- `artifacts/reference-layout-generated-model-2026-10-21/reference-layout-generated-room-preview-adopted.png`
- `artifacts/reference-layout-generated-model-2026-10-21/reference-layout-generated-room-applied.png`
- `artifacts/reference-layout-generated-model-2026-10-21/reference-layout-generated-room-reloaded.png`
- `artifacts/reference-layout-generated-model-2026-10-21/reference-layout-generated-room-browser-receipt.json`
- `artifacts/reference-layout-generated-model-2026-10-21/live-entry-director.png`：线上进入既有导演台并看到“参考图粗布景”入口；未调用生成任务。
