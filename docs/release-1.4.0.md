# v1.4.0 — 和模型在 YGOPro2 里对局

这一版有两件事：修好了连接怪兽的格子提示，以及可以直接在 YGOPro2 里和模型打一局。

## 修复：连接怪兽的箭头与指向格子

- **箭头读错**：引擎返回连接信息时先给连接值、再给箭头，旧代码把连接值当成了箭头。比如交织绵羊（LINK-2，左下/右下）会被显示成“箭头下”。
- **指向格子偏移**：额外怪兽区的箭头对应格子整体错了一格，例如额外怪兽区 5 的左下被算成主怪兽区 1，正确是主怪兽区 0。现在按 ocgcore `card::get_linked_zone` 计算，也补上了额外怪兽区指向对方主怪兽区、主怪兽区 0/4 斜上指向额外怪兽区的情况，双方的连接怪兽都会算。

## 新增：和模型对局

对模型说“开个房间和我打一局”，就能在 YGOPro2 里和它对战：

1. 模型载入卡组并开房，插件自动打开 YGOPro2 并进房。
2. 你在 YGOPro2 里点准备、开始对局；DSH 会自动接上，不用再回 DSH 说“开始”。
3. 模型每一步操作都显示在 DSH 对话里，游戏内聊天双向转发。

细节：

- **自带服务端**：对战服务端 AI.Server 和模型用的 WindBot 随插件提供，使用插件自己的卡库和脚本；更新卡库后，下一次开房就会用上新卡。
- **少打断**：只有一个选项的决策（最常见的是只有“不连锁”的连锁窗口）由插件直接应答。实测一局里约 70% 的决策是这种，现在都不会再停下来；有两个及以上选项时仍由模型按卡面判断。
- **安全默认**：房间默认只监听 `127.0.0.1`，只有显式指定 `bindAddress:"0.0.0.0"` 才对局域网开放。房间不设密码，开放前请确认网络环境。

## 两种安装包

| 文件 | 内容 | 适合 |
| --- | --- | --- |
| `ygo-tools-for-dsh-1.4.0-integrated.tgz` | 插件 + YGOPro2 客户端（不含卡图） | 没装 YGOPro2，想直接和模型对局 |
| `ygo-tools-for-dsh-1.4.0-external.tgz` | 只有插件 | 已经装了 YGOPro2，或只用卡查、推演 |

```powershell
# 集成包
dsh plugin --profile web add "https://github.com/mellfy-puppy/ygo-tools-for-dsh/releases/download/v1.4.0/ygo-tools-for-dsh-1.4.0-integrated.tgz"

# 外置包
dsh plugin --profile web add "https://github.com/mellfy-puppy/ygo-tools-for-dsh/releases/download/v1.4.0/ygo-tools-for-dsh-1.4.0-external.tgz"
```

集成包开房时只用自带客户端，不会搜索或改动本机其他 YGOPro2。外置包会按环境变量和常见安装位置查找本机 YGOPro2，找不到时把房间地址告诉你手动加入。

## 其他修复

- **卡库刷新**：基础脚本（`constant.lua` / `utility.lua` / `procedure.lua`）现在随刷新一起更新。之前只补缺失文件，新卡脚本用到的 `FusionSpell`、`CATEGORY_DECK_SPSUMMON` 等定义不存在，约 130 张卡会加载失败。
- **随包卡库**已更新到 2026-10-08 的官方数据。

## 许可说明

插件代码为 0BSD。集成包内的 YGOPro2 客户端（[YGOProUnity_V2](https://github.com/lllyasviel/YGOProUnity_V2)）和随插件提供的 AI.Server 为 GPLv3，许可证随包附带。卡图不随包分发。

## 验证

- 外置模式下实测：开房、自动进房、完整对局、聊天、单选项自动应答。
- 集成客户端实测：自动启动并在 7 秒内进房。
- 48 项自动化测试全部通过。
