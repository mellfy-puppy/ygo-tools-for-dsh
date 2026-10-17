# v1.5.0

## 适配 DSH 0.2.x

更新插件与预设以兼容 DeepSeek Harness 0.2.x（已在 0.2.1-rc.1 和 0.2.1-rc.2 桌面版上验证）。工具、卡库和 YGOPro2 对局功能与 v1.4.0 相同。

- `peerDependencies` 兼容范围更新为 `>=0.2.1-rc.1 <0.3.0`。DSH 0.1.x 请继续使用 [v1.4.0](https://github.com/mellfy-puppy/ygo-tools-for-dsh/releases/tag/v1.4.0)。
- “游戏王模式”预设与 DSH 0.2.1 标准模式对齐：补充 `time-context`、`tool-schedule` 及默认关闭的 `tool-plugin-market`，移除 0.2 已不再配置的子代理参数与 `persona` 里的 `{{cwd}}` 后缀（工作目录改由 DSH 自带插件提供）。
- 开房后的后台等待任务 `owner` 改为会话 id，适配 DSH 0.2 的后台任务归属查找规则。

## 安装包

本版本提供两个安装包，插件代码相同：

- `ygo-tools-for-dsh-1.5.0-integrated.tgz`：附带 YGOPro2 客户端（不含卡图），不需要另装 YGOPro2。
- `ygo-tools-for-dsh-1.5.0-external.tgz`：不含客户端，使用本机已安装的 YGOPro2。

```powershell
dsh plugin --profile desktop add "https://github.com/mellfy-puppy/ygo-tools-for-dsh/releases/download/v1.5.0/ygo-tools-for-dsh-1.5.0-integrated.tgz"
dsh plugin --profile desktop add "https://github.com/mellfy-puppy/ygo-tools-for-dsh/releases/download/v1.5.0/ygo-tools-for-dsh-1.5.0-external.tgz"
```

桌面版默认 profile 为 `desktop`；命令行启动的 Web 版一般为 `web`。也可以在 DSH 设置的插件页面填入上面的地址安装。

## 其他

- YGOPro2 客户端和 AI.Server 为 GPLv3，许可证在包内；插件代码仍为 0BSD。