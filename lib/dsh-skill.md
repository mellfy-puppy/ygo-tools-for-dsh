---
name: ygo-tools-for-dsh
description: 游戏王专用技能：通过 15 个聚合式 YGO 工具完成卡查、卡组管理、持久引擎对局、固定起手、检查点、YGOPro2 AI.Server 对战、录像分析及卡组学习。学习成果保存为 skill，在使用匹配卡组时自动激活。
---

# YGO 对战引擎工作方式

本预设在当前 DSH 标准模式上挂载 `ygo-tools-for-dsh`，增加 15 个聚合式
YGO 工具。引擎首次调用时自动启动并跨 DSH 重启保留。游戏王后端操作
使用这些注册工具，不经 shell、eval、Node import、HTTP、CLI 或自建包装
脚本绕过工具。若当前 DSH 将工具呈现为 `run_code` 中的生成式 SDK，按
DSH 提供的 SDK 调用即可；这是框架工具通道。

## 工作流

1. 每个 YGO 任务先调用 `manageEngineSession({action:"status"})`。
2. 直接使用注册工具；不要枚举内部后端命令，也不要创建或传递
   `sessionId`。
3. 卡查用 `queryCards`；卡组用 `manageSessionDeck`；场面与合法动作使用
   `observeDuel`；分支回滚使用 `manageCheckpoint`。
4. `executeAction` 成功后直接消费返回的 `state` 和
   `nextDecision.actions`，仅在缺失、截断、失败、中断或无进展时重新
   `observeDuel`。
5. 录像使用 `analyzeReplay`，旧 Combo 使用 `analyzeCombo`；学习录像并
   保存卡组经验用 `learnDeck`。用户明确要求其他文件输出时才调用
   `saveArtifact`。
6. 工具在当前 DSH 工具目录或 SDK 中不存在时报告加载问题；先区分工具
   呈现方式与注册失败，不自建后端访问路径。

## 15 个公开工具

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
- `learnDeck`: `learn` / `list` / `get` / `activate` / `delete`
- `saveArtifact`: `replay` / `route`
- `manageEngineSession`: `status` / `clear` / `shutdown`

## 从录像学习卡组

1. 用户要求学习录像时，先用 `analyzeReplay` 获取已解析操作和上下文。
   基于这些证据提取起手条件、关键操作、资源要求、分支判断和可复用的
   操作经验；无法从录像确认的内容标为未知。
2. 将模型提炼的经验填入 `strategyNotes`，交给
   `learnDeck({action:"learn",strategyNotes:"..."})` 保存。省略录像参数
   时复用刚刚解析的录像；需要其他录像或卡组时显式指定。保留解析器
   提供的操作证据，禁止凭记忆补出不存在的动作。学习请求本身已授权
   保存相应 skill 文件，无须另建脚本或报告。
3. 用 `learnDeck({action:"list"})` 查找已保存内容，用 `get` 查看具体
   skill。卡组加载和修改后会按卡组指纹匹配，并通过 DSH 的延后上下文
   自动激活相应内容。需要重新读取或明确激活时使用 `activate`。
4. 以最新的卡组学习上下文为准；切换到不匹配卡组或清空引擎会话后，
   先前 skill 不再生效。指纹匹配保留主卡组、额外及副卡组的卡片重数；
   卡组改变后不要假设旧经验自动适用。
5. 录像经验不是当前合法性的证明。实际执行前用当前合法动作验证，
   不直接复用其他对局中的动作序号、位置或随机结果。用户要求删除
   已保存经验时才使用 `delete` 并传 `confirm:true`。

## 硬性规则

- 以工具输出为准，不凭记忆断言卡文、卡组归属、合法动作、场面或录像。
- YDK 文本原样传给 `manageSessionDeck({action:"set",ydk})`，绝不手工解析。
- 固定起手通过 `resetGame({fixedOpening:[...]})` 设置，不补随机牌。
- 真实对局必须显式使用 `duelBackend:"ygopro2"`、对手配置和先后手，并以
  `manageYgoPro2({action:"status"})` 的 `liveDuelBridge:true` 为准。
- AI.Server 对局不可回滚；固定起手、模拟和检查点只适用于内嵌 runner。
- 用户要求结束并导出真实对局时，才调用
  `saveArtifact({action:"replay",surrenderIfRunning:true,...})`。
- 普通卡查和对局默认纯内存；学习卡组会保存对应 skill。其他路线、
  录像、报告、日志、调试转储或工作流文件只在用户要求时写入。
- `manageEngineSession` 的 `clear` / `shutdown` 必须有明确需求并传
  `confirm:true`。
- 不创建数值化对局评分；直接比较已验证的资源、封锁、区域和合法后续。
