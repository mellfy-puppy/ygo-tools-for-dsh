---
name: ygo-tools-for-dsh
description: 游戏王专用技能：通过 14 个聚合式 YGO 工具完成卡查、卡组管理、持久引擎对局、固定起手、检查点、YGOPro2 AI.Server 对战与录像分析导出。普通工作纯内存，不创建脚本、报告或日志。
---

# YGO 对战引擎工作方式

本预设挂载 `ygo-tools-for-dsh`，只向模型注册 14 个聚合式 YGO
工具。引擎首次调用时自动启动并跨 DSH 重启保留。模型不得经 shell、
eval、Node import、HTTP、CLI 或包装脚本调用后端。

## 工作流

1. 每个 YGO 任务先调用 `manageEngineSession({action:"status"})`。
2. 直接使用注册工具；不要枚举内部后端命令，也不要创建或传递
   `sessionId`。
3. 卡查用 `queryCards`；卡组用 `manageSessionDeck`；场面与合法动作使用
   `observeDuel`；分支回滚使用 `manageCheckpoint`。
4. `executeAction` 成功后直接消费返回的 `state` 和
   `nextDecision.actions`，仅在缺失、截断、失败、中断或无进展时重新
   `observeDuel`。
5. 录像使用 `analyzeReplay`，旧 Combo 使用 `analyzeCombo`，用户明确要求
   写文件时才调用 `saveArtifact`。
6. 只有 DSH 直接报 `manageEngineSession` 未知才证明插件注册失败；此时
   停止并报告，绝不自建后端访问路径。

## 14 个公开工具

- `queryCards`: `get` / `search`
- `manageCardDataSources`: `inspect` / `refresh`
- `manageYgoPro2`: `discover` / `status`
- `getBanlistContext`
- `manageSessionDeck`: `set` / `get` / `check` / `edit` / `export`
- `resetGame`
- `observeDuel`: `state` / `actions`
- `executeAction`
- `simulateActions`
- `manageCheckpoint`: `save` / `restore` / `list` / `delete`
- `analyzeReplay`: `parse` / `context` / `analyze`
- `analyzeCombo`: `parse` / `adapt`
- `saveArtifact`: `replay` / `route`
- `manageEngineSession`: `status` / `clear` / `shutdown`

## 硬性规则

- 以工具输出为准，不凭记忆断言卡文、卡组归属、合法动作、场面或录像。
- YDK 文本原样传给 `manageSessionDeck({action:"set",ydk})`，绝不手工解析。
- 固定起手通过 `resetGame({fixedOpening:[...]})` 设置，不补随机牌。
- 真实对局必须显式使用 `duelBackend:"ygopro2"`、对手配置和先后手，并以
  `manageYgoPro2({action:"status"})` 的 `liveDuelBridge:true` 为准。
- AI.Server 对局不可回滚；固定起手、模拟和检查点只适用于内嵌 runner。
- 用户要求结束并导出真实对局时，才调用
  `saveArtifact({action:"replay",surrenderIfRunning:true,...})`。
- 默认纯内存，不写路线、录像、报告、日志、调试转储或工作流文件。
- `manageEngineSession` 的 `clear` / `shutdown` 必须有明确需求并传
  `confirm:true`。
- 不创建数值化对局评分；直接比较已验证的资源、封锁、区域和合法后续。
