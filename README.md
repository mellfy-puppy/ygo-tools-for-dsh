<div align="center">

# YGO Tools for DSH

**面向 DeepSeek Harness 的游戏王研究工具**

卡片数据 · 卡组分析 · 规则验证 · Combo 推演 · 录像复盘

</div>

<div align="center">

`DSH 插件`　`OCG 规则引擎`　`YGOPro2 桥接`　`Node.js 22+`

</div>

<br>

YGO Tools for DSH 是一个面向 DeepSeek Harness 的原生游戏王工具插件。它把卡片数据、禁限表、卡组管理和 OCG 规则引擎接入模型，使游戏王研究从文本查询进入可验证的决斗状态。

## 快速开始

从 GitHub Release 安装插件：

```powershell
dsh plugin --profile web add "https://github.com/mellfy-puppy/ygo-tools-for-dsh/releases/download/v1.3.0/ygo-tools-for-dsh-1.3.0.tgz"
```

安装插件后，Web 界面在新建会话时即可直接选用“游戏王模式”。该模式在 DSH 0.1.7-rc.2 标准能力基线上，叠加注入专属游戏王工具链。

若 Web 端未显示新预设，重启 DSH 后新建会话并选择“游戏王模式”即可。升级前已经开始的会话保留原有预设绑定。

[查看 v1.3.0 更新说明](./docs/release-1.3.0.md)

## 项目概览

```text
┌──────────────────────┐     ┌─────────────────────────┐
│   DeepSeek Harness   │────▶│    YGO Tools for DSH    │
└──────────────────────┘     └────────────┬────────────┘
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              ▼                           ▼                           ▼
       卡片知识库                  规则验证                    决斗桥接
       卡片 · 禁限表               OCG 引擎 · 分支推演          YGOPro2 · AI.Server
```

插件负责工具注册、会话管理和结果返回；规则引擎在独立进程中按需运行，维护局面并计算合法动作。

## 主要能力

<table>
<tr>
<td width="33%" valign="top">

### `01` 卡片数据

查询卡片、卡文、属性、类型、数值和关联信息。

读取禁限表和卡库状态；正式卡与先行卡数据可按需更新。

</td>
<td width="33%" valign="top">

### `02` 卡组与 Combo

装载、检查、编辑和导出 YDK 卡组。

解析 Combo 路线，验证动作顺序，并比较不同展开分支。

</td>
<td width="33%" valign="top">

### `03` 决斗状态

创建局面、设置起手、观察合法动作并执行操作。

支持检查点、录像分析，以及可选的 YGOPro2 桥接。

</td>
</tr>
</table>

## 工具一览

| 类别 | 工具 |
| :--- | :--- |
| **卡片** | `queryCards` · `manageCardDataSources` · `getBanlistContext` |
| **卡组** | `manageSessionDeck` · `learnDeck` |
| **决斗** | `resetGame` · `observeDuel` · `executeAction` · `simulateActions` |
| **状态** | `manageCheckpoint` · `manageEngineSession` |
| **分析** | `analyzeCombo` · `analyzeReplay` · `saveArtifact` |
| **桥接** | `manageYgoPro2` |

## 卡组录像学习与 Skill 上下文动态注入（`learnDeck`）
工具集总数由 14 项扩充至 15 项，新增 `learnDeck` 工具，为模型引入自动化卡组经验归纳与复用能力：
- **操作提取与策略复盘**：从 YRP 决斗录像中提取可见操作流，由模型结合对局复盘提炼策略要点（`strategyNotes`），并持久化为与卡组强绑定的 Markdown Skill 文件。
- **系统边界与定位**：本方案属于“外部持久化 Skill 存储与动态会话上下文检索注入”，不改动模型底层权重；录像提取的操作与模型总结提供策略指导，实际对局仍以运行时生成的合法动作集为准进行动态核验。若录像解析中断或不完整，系统将明确标注为仅覆盖前缀操作。
- **卡组指纹与精准匹配**：卡组指纹覆盖主卡组（Main）、额外卡组（Extra）与副卡组（Side），采用多重集比对（忽略构筑排列顺序，严格保留同名卡数量）。卡表调整将自动切断旧 Skill 匹配；当 YRP 录像未包含副卡组数据时，支持降级绑定主卡组与额外卡组完全一致的当前会话卡组。
- **全生命周期管理**：`learnDeck` 提供学习（`learn`）、检索（`list`）、查看（`get`）、激活（`activate`）及删除（`delete`）五项核心操作，策略复盘支持二次更新保存；覆盖存量记录与物理删除必须显式传入对应参数。


```json
{ "action": "learn", "file": "C:/replays/example.yrp", "deckName": "我的卡组", "skillName": "my-deck", "strategyNotes": "由模型在复盘后填写策略总结。" }
```

```json
{ "action": "list", "matchingOnly": true }
```

```json
{ "action": "get", "skillName": "my-deck" }
```

```json
{ "action": "delete", "skillName": "my-deck", "confirm": true }
```

- **技能存储路径**：Skill 默认持久化保存在 `$DSH_HOME/ygo-tools-for-dsh/deck-skills`，可通过插件配置参数 `deckSkillDir` 或环境变量 `YGO_DECK_SKILL_DIR` 灵活重定向。

## 运行方式

```text
DSH 会话
    │
    ├─ 工具调用 ────────────────┐
    │                           ▼
    │                    YGO 插件进程
    │                           │
    │                    持久引擎客户端
    │                           │
    └───────────────────────────▼
                         OCG 规则引擎
                         127.0.0.1:19981
```

- 引擎按需启动，挂载插件本身不会立即启动决斗进程。
- 决斗状态和研究过程默认保存在内存中。
- 只有在明确要求时才导出路线、录像等文件；`learnDeck` 的 `learn` 操作会保存技能文件。
- YGOPro2 是可选外部后端。

## 适用范围

适合用于卡片检索、卡组检查、Combo 验证、决策分支比较和录像复盘。

为了轻量化，内置引擎不是图形化游戏客户端，也没有YGOPRO的人机交互等功能，但有着相关的接口对接。

## 项目结构

```text
lib/                  插件入口与 DSH 技能说明
skill/backend/        工具、会话与引擎服务
skill/resources/      卡库、脚本与 WASM 资源
skill/references/     数据来源与研究规则
skill/vendor/         随包提供的运行依赖
```

## 许可

[0BSD](./LICENSE)

卡片数据库、禁限表、卡片脚本及其他数据资源遵循各自上游项目的许可与分发条款。
