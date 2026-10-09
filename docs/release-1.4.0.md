# v1.4.0

## 新增：与 AI 对局

现在可以在 YGOPro2 里和模型对局。在 DSH 里让模型载入卡组并开房，YGOPro2 会自动打开并进入房间，点准备即可开始。

- 对局开始后 DSH 会话自动继续，不需要再回 DSH 输入“开始”。
- 模型的每一步操作都显示在 DSH 对话里；游戏内聊天会转给模型，模型也能回复。
- 只有一个选项的决策（例如只能选“不连锁”）由插件直接处理，不再询问模型。
- 服务端（AI.Server）和模型使用的 WindBot 随插件附带，使用插件内的卡库。更新卡库后，下次开房即生效。
- 房间默认只监听 `127.0.0.1`。设置 `bindAddress:"0.0.0.0"` 可让局域网内的电脑加入，房间没有密码。

## 安装包

本版本提供两个安装包，插件代码相同：

- `ygo-tools-for-dsh-1.4.0-integrated.tgz`：附带 YGOPro2 客户端（不含卡图），不需要另装 YGOPro2。
- `ygo-tools-for-dsh-1.4.0-external.tgz`：不含客户端，使用本机已安装的 YGOPro2。

```powershell
dsh plugin --profile web add "https://github.com/mellfy-puppy/ygo-tools-for-dsh/releases/download/v1.4.0/ygo-tools-for-dsh-1.4.0-integrated.tgz"
dsh plugin --profile web add "https://github.com/mellfy-puppy/ygo-tools-for-dsh/releases/download/v1.4.0/ygo-tools-for-dsh-1.4.0-external.tgz"
```

## 其他

- 修复连接怪兽的箭头和指向格子显示错误。
- 更新卡库时会一并更新 `constant.lua` 等基础脚本，修复部分新卡脚本加载失败。
- 随包卡库更新至 2026-10-08。
- YGOPro2 客户端和 AI.Server 为 GPLv3，许可证在包内；插件代码仍为 0BSD。
