# 参考图统一多视图合同改造

## 统一多视图合同改造（2026-10-21）

状态：实现与本地验证完成；本轮依用户明确授权提交并推送至 `origin/main`，不部署。独立记录本轮统一多视图改造；人工基线与原始工作区状态位于本文指定artifact目录。禁止真实 provider 请求及 HF/GPU 调用。

### 执行清单

- [x] 冻结现有输入/输出链路、worktree/index/5175状态；既有 dirty 保持原样。基线快照在 `artifacts/unified-multiview-layout-contract-2026-10-21/baseline/`，开始阶段HEAD为`8165ffb`且index为空；本轮只暂存下方manifest所列改动。
- [x] 定义并实现 v2 唯一实体注册表 + sourceId 分视图观察合同；global registry承载身份/语义/placement/稳定姿态，逐图只保留图像局部证据，严格拒绝未知字段、错误kind字段、非法bbox/嵌套/引用/关系冲突与环。单值support/partOf/facing冲突拒绝，against允许多面墙；contact与landmark同pointId必须同floor plane；sourceId最长128，entityId最长48。合同负例与兼容测试7项通过，日志见 `artifacts/unified-multiview-layout-contract-2026-10-21/logs/v2-contract-node-tests-2026-10-22.txt`。
- [x] 所有图片地位平等，UI移除主图/辅图/切主图；内部按几何可用性、证据覆盖和稳定来源key自动选择解算frame。上传图序的合同/转换测试通过。
- [x] 实现地面平面证据的受限跨视图配准/融合；只映射明确对应的共面地面点，不变换bbox/立面点；不能配准时保留未定位提示并标 needsReview。
- [x] v2 review 原子返回并完整重新验证，可修正身份/类别/bbox/漏检；请求组指纹与 abort 防止旧响应覆盖新图组；v1和已保存草稿兼容。
- [x] 离线合同、转换、非法输入、图序、重复/不同实体、review纠错和preview/apply一致性验证；真实浏览器以离线API mock完成2图上传→生成→预览→应用与刷新后的待定位状态显示。
- [x] 更新本清单中的实际改动、验证证据和空间质量边界；未声称mesh无穿插、真实VLM精度或真实场景的多视角相机标定。

### v2 合同草案

```json
{
  "contractVersion": "image-observations-v2",
  "spaceType": "enclosed|open|outdoor|unknown",
  "entities": [{"id":"surface-id","kind":"surface","name":"floor","surfaceKind":"floor","identityConfidence":0.8,"uncertain":false},{"id":"item-id","kind":"item","name":"chair","semanticType":"chair","category":"chair","placement":"floor","identityConfidence":0.8,"uncertain":false}],
  "views": [{
    "sourceId":"input-source-id",
    "entities":[{"entityId":"surface-id","side":"floor","bbox":[0,0,1,1],"confidence":0.9,"visibility":"visible","mainColor":null},{"entityId":"item-id","bbox":[0,0,1,1],"confidence":0.8,"visibility":"visible|partly_occluded|occluded|uncertain","mainColor":null,"contactWallSide":"image_left|image_right|image_back|unknown|none","bodyExtendsToward":"image_left|image_right|image_up|image_down|unknown","rearFeature":{"name":"visible feature","bbox":[0,0,1,1]},"visibleBbox":[0,0,1,1],"completeBbox":[0,0,1,1],"groundContacts":[{"point":[0.5,0.8],"kind":"center","visibility":"visible","confidence":0.8,"pointId":"same-contact-id","planeId":"surface-id"}]}],
    "groundLandmarks":[{"pointId":"same-physical-point-id","planeId":"surface-id","point":[0.5,0.8],"confidence":0.8,"visibility":"visible"}],
    "geometryEvidence":{"axes":[]}
  }],
  "relations":[{"type":"support|partOf|against|facing","from":"entity-id","to":"entity-id","confidence":0.8}]
}
```

每个二维框、轮廓、接触点、可见性、遮挡、画面左右/轴线都隶属且只能隶属一个 sourceId。跨视图实体共享 entityId；全局关系只表达视角不变事实。世界坐标、米制尺寸与相机位姿仍由程序估计。平面映射只接受显式重复的相同物理地面点，且需通过非退化和重投影残差门限；不满足时标记该 view unregistered，不拼坐标。

### 阶段记录：共享合同与离线负例

- `functions/shared/director-layout-observations.js`：V2独立prompt明确图片输入平等、按可见性/置信度加权；V1主辅标签和坐标规则保持兼容。V2视图shape覆盖局部朝向、墙接触、可见/完整框、背面特征、地面证据与遮挡；不可视姿态方向要求unknown。提示中有三个按kind分开的row例子和一份被parser直接验过的完整最小JSON样例，并包含凹footprint/hole、接触证据与axes注意事项。
- `micro-apps/director-desk/src/editor/schema/multiViewObservation.ts`：canonical adapter保留V2 canonical view的`contactWallSide`、`bodyExtendsToward`、`rearFeature`、`visibleBbox`、`completeBbox`字段。
- `tests/director-layout-multiview-v2-contract.test.mjs`：7/7通过，覆盖1/2/3来源注册表、嵌套/数量边界、单值关系冲突与组合环、多墙against、跨图pointId-plane冲突、kind错误、人物遮挡视图与直接可见姿态、sourceId长度及V1/V2提示兼容、完整提示样例可被V2 parser接收。
- `micro-apps/director-desk/src/editor/schema/multiViewObservation.test.ts`：5/5通过。确定性 homography反例覆盖图序、4点不足、离群点、共线退化和重复pointId；converter实测成功配准带回planeId，非canonical ground contact经地面映射后改变canonical接触位置，但绝不替换其bbox；跨view接触点裁至6条并保留实际参与来源；语义冲突标记geometry review；自动frame优先真实可用标定，再按稳定sourceId tie-break。
- 显式 micro TypeScript检查`npm exec tsc -- --noEmit -p tsconfig.json`退出码0；真实日志为`artifacts/unified-multiview-layout-contract-2026-10-21/logs/director-desk-tsc-final-2026-10-22.txt`。node/Worker多视图API测试45/45通过；合同、配准、转换与客户端定向测试115/115通过，派生诊断正反例和应用用例通过，面板持久待定位状态回归1/1通过。精确命令与退出状态分别记录在`logs/node-worker-final-2026-10-22.txt`、`logs/ground-fusion-vitest-2026-10-22.txt`、`logs/derived-diagnostics-vitest-2026-10-22.txt`、`logs/panel-persisted-resolution-vitest-2026-10-22.txt`。
- 完整`ReferenceLayoutPanel.test.tsx`回归24/24通过，覆盖平等视图V2请求、取消/替换/更新、裁图、单图V1兼容、预览编辑与应用等。更新测试使用及时Image加载失败模拟，不缩短生产5秒上限；旧主辅/切主图断言改为V2角色无关行为。初次完整跑发现18/24旧断言/等待失败，记录在`logs/reference-layout-panel-pre-fix-2026-10-22.txt`；修正后全量日志与精确TypeScript `exit 0`证据见`logs/reference-layout-panel-and-tsc-final-2026-10-22.txt`。
- 浏览器Smoke使用5175真实入口和真实UI点击上传/生成/应用，API由离线mock响应；mock让第二图独见椅子因缺少可靠注册保留为待定位。1600×1000同机位截图对比新批次逐ID位置/尺寸/Y旋转/可见性，2/2匹配；刷新后通过现有`useDirectorStore.openSceneInspector`打开场景检查器，已恢复批次“已识别2/已定位1/待定位1”及`椅子（browser-view-side.png）`原因。开场景检查器这一步为程序调用；空白canvas点击已尝试但未切换面板。页面资源404仅是`/favicon.ico`。完整结果与边界见`artifacts/unified-multiview-layout-contract-2026-10-21/browser-smoke-v2.json`、`browser-preview.png`、`browser-applied.png`、`browser-applied-reloaded.png`及`logs/browser-smoke-final-2026-10-22.txt`。
- 标准root `npm run build`在隔离的精确源码副本中成功，避免覆盖主工作区已dirty的`public/director-desk`；摘要与warning见`logs/isolated-root-build-2026-10-22.txt`。root build输出仅有大chunk警告。原入口5175监听PID 28968保持不变。全部改动通过`git diff --check`。
- 真实VLM调用未进行；浏览器mock和fixture只验证合同链路、未定位提示、持久化数据与应用变换一致性，不能证明真实多图身份判别精度或完整空间还原。mesh实际交叉与整房视觉质量未测；应用比较只断言新批次position/size/Y rotation/visible，不代表原场景全对象完全一致。地面融合仅在显式对应点满足安全门限时运行；未注册的独见实体必须保持待定位。

\n
