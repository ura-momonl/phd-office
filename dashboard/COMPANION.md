# 可选的外部小场景

小场景的网页、脚本、样式和人物/背景图片作为独立资源包放在代码仓库外。未配置或资源目录不存在时，办公室不显示小场景、不请求场景文件，聊天和每日留言照常使用。

在本机创建 `dashboard/companion.local.json`（Git 已忽略）：

```json
{"directory":"D:/your-personal-resources/companion"}
```

目录需包含 `index.html`，其中脚本、样式、图片使用相对路径。办公室通过 `/companion/` 提供这个包，iframe 仍只开放 `allow-scripts`。只提供 `.html/.js/.css/.png`，不提供隐藏文件/目录、tests、链接文件或其他资料。资源包是本机选择的可信网页代码，不是自动下载的插件。

配置目录后重启后端；已存在资源的内容修改刷新即可，新增文件需重启重新登记。不配置就无需准备任何素材。非个性化分发不要包含本机的 `*.local.json` 或外部资源包。

`node scripts/run-tests.mjs --companion-ui --keep` 会把已配置包的公开素材复制到脱敏测试目录，测试副本不再引用本机原目录。没配置包时仍测试通用加载入口及无场景聊天；仅针对个人场景的动画/UI 检查标记跳过。场景细节说明随资源包保存在其 `README.md`。
