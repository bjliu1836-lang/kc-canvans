# 上游来源

本目录同步自独立版 3D 导演台，并作为无限画布的 iframe 子应用构建：

- 当前同步仓库：<https://github.com/xiaozangao/3d-director-desk>
- 当前同步提交：`09baf48b0ce2fdd14e674fac928dee922a90b1cd`（v0.3.0）
- 原始上游仓库：<https://github.com/jiguang132/storyai-3d-director-desk>
- 原始上游提交：`8c8bd36`
- 保留上游 `LICENSE`。

本地改动目标：

1. 保持为独立 Vite 子应用，并由无限画布主项目统一构建；
2. 通过 iframe / postMessage 供无限画布宿主页面引入；
3. 允许通过 `hostOrigin` 查询参数配置父页面 origin，支持本地跨端口开发，例如父页面 `localhost:3000`、导演台 `localhost:5173`；
4. 截图结果通过消息回传给宿主，由宿主决定是否保存成画布图片节点。
