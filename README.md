<div align="center">

# YGO Tools for DSH

**面向 DeepSeek Harness 的游戏王研究工具**

卡片数据 · 卡组分析 · 规则验证 · Combo 推演 · 录像复盘

</div>

<div align="center">

`DSH 插件`　`OCG 规则引擎`　`YGOPro2 桥接`　`Node.js 20+`

</div>

<br>

YGO Tools for DSH 是一个面向 DeepSeek Harness 的原生游戏王工具插件。它把卡片数据、禁限表、卡组管理和 OCG 规则引擎接入模型，使游戏王研究从文本查询进入可验证的决斗状态。

## 快速开始

从 GitHub Release 安装插件：

```powershell
dsh plugin --profile web add "https://github.com/mellfy-puppy/ygo-tools-for-dsh/releases/download/v1.2.0/ygo-tools-for-dsh-1.2.0.tgz"
```

然后在预设的 `agent.cordis.yml` 中挂载：

```yaml
- id: ygo-tools
  name: ygo-tools-for-dsh
```

使用该预设创建新会话即可。规则引擎会在第一次调用游戏王工具时启动。

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
| **卡组** | `manageSessionDeck` |
| **决斗** | `resetGame` · `observeDuel` · `executeAction` · `simulateActions` |
| **状态** | `manageCheckpoint` · `manageEngineSession` |
| **分析** | `analyzeCombo` · `analyzeReplay` · `saveArtifact` |
| **桥接** | `manageYgoPro2` |

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
- 只有在明确要求时才导出路线、录像等文件。
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
