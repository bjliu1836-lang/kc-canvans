# 寺庙参考图粗布景诊断证据

本目录保存 2026-10-13 对同一张寺庙参考图的两次本地服务响应与诊断证据。两次请求均已发生；本目录整理过程没有再次调用收费模型。

- `old-service-response.json`：`127.0.0.1:8787` 旧进程返回。该进程 PID 42128，启动于 2026-10-12 17:25:48，早于本轮实现，因此只能作为旧链路基线，不能用于评价当前 prompt 或 DeepSeek 能力。
- `current-prompt-response.json`：`127.0.0.1:8788` 临时启动当前 `server/server.mjs` 后的返回。临时服务已经停止。
- `model-run-metadata.json`：两次调用的可核验元数据、token usage、当前 prompt 哈希和证据边界。

响应文件是本地 `/api/director-layout` 返回的 JSON；服务端已完成 JSON 提取与结构校验，因此它们是可复现 UI fixture，不等同于供应商 HTTP 的未处理原始响应包。
