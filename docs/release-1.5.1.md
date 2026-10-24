# v1.5.1

## 修复：效果编号标错，模型以为卡不能发动

部分卡在动作列表里的效果编号会标错，后面附的也是另一个效果的文本。例如手卡的「流星辉巧群」满足仪式条件时，①被标成“卡面效果②”，附带的是②“这张卡在墓地存在的场合……”的文本，模型因此以为只有墓地效果，不去发动①。点下这个动作实际发动的仍是①；host 开房和 embedded 两种后端都会出现。

原因：卡库里很多卡没有填效果提示文本（`str1`~`str16` 为空），插件只能按顺序把引擎的效果序号对应到卡面的①②。对应时会先筛掉“看起来不能发动”的效果，依据是文本里有没有“发动 / 才能 / 场合 / 时”等词。魔法卡的①常常一个都没有，被筛掉后，序号 0 就落到了②上。

修复：对应时结合卡片当前所在区域（手卡 / 场上 / 墓地 / 除外），卡面写明在其他区域发动的效果不再参与对应。仍无法确定时，显示引擎自带的提示文本，不再给出编号。全卡库核对 4493 个情形，区域对不上的标签从 72 处降到 0，原本正确的没有改变。

## 其他

- 局面里显示场上怪兽的实际攻守：`observeDuel` 的状态里新增 `monsterDetails`，列出区域、表示形式、当前攻守，数值被改过时附原本值，例如 `攻1000（原本2000）`。对方里侧表示的怪兽不显示攻守。
- 修正怪兽表示形式的读取：引擎返回的值打包了控制者、区域、序号和表示形式，以前整体当作表示形式用，无法区分表侧和里侧。

## 安装包

本版本提供两个安装包，插件代码相同：

- `ygo-tools-for-dsh-1.5.1-integrated.tgz`：附带 YGOPro2 客户端（不含卡图），不需要另装 YGOPro2。
- `ygo-tools-for-dsh-1.5.1-external.tgz`：不含客户端，使用本机已安装的 YGOPro2。

```powershell
dsh plugin --profile desktop add "https://github.com/mellfy-puppy/ygo-tools-for-dsh/releases/download/v1.5.1/ygo-tools-for-dsh-1.5.1-integrated.tgz"
dsh plugin --profile desktop add "https://github.com/mellfy-puppy/ygo-tools-for-dsh/releases/download/v1.5.1/ygo-tools-for-dsh-1.5.1-external.tgz"
```

桌面版默认 profile 为 `desktop`；命令行启动的 Web 版一般为 `web`。也可以在 DSH 设置的插件页面填入上面的地址安装。

- YGOPro2 客户端和 AI.Server 为 GPLv3，许可证在包内；插件代码仍为 0BSD。