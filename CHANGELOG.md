# Changelog

## 1.2.0 — 2026-08-21

- 项目更名为 **YGO Tools for DSH**。
- 包名改为 `ygo-tools-for-dsh`，DSH 挂载 ID 统一为 `ygo-tools`。
- 发布目录、安装包文件名和 GitHub Release 资源名称统一为 `ygo-tools-for-dsh`。

## 1.1.2 — 2026-08-20

- 放宽 DSH peer 兼容范围至 `>=0.1.0-rc.6 <0.2.0`，兼容 rc7/rc8 的预发布版本。
- 保持 14 个聚合工具和多效果卡编号映射修复不变。

## 1.1.1 — 2026-08-19

- 修复多效果卡的 `Stringid` 与卡面①②③编号错位：不再把引擎序号直接当作卡面效果序号。
- 发动/连锁动作现在携带明确的卡面效果引用或引擎效果标识；无法唯一映射时保留完整卡牌原文，不显示空效果或猜测编号。
- 新增真刀竹光、守护者之力、太阳神之翼神龙-不死鸟等多效果卡的通用回归校验。

## 1.1.0 — 2026-08-19

- 将模型可见工具收敛为 14 个功能域工具，降低 DeepSeek 上游的工具数量与 schema 负担。
- 卡组、数据源、YGOPro2、观察、检查点、录像、Combo、导出和引擎管理通过显式 `action` 参数聚合；底层规则能力保持不变。
- 固定起手合并进 `resetGame.fixedOpening`，录像解析与上下文构建可由 `analyzeReplay({action:"analyze"})` 一次完成。
- 删除旧公开工具名称的技能指引和发行说明，DSH 仅注册新的 14-tool schema。

## 1.0.2 — 2026-08-16

- 修复通用多卡选择标签：枚举式 `SelectCard` 选择现在在标签中按响应顺序列出每个候选序号与卡名，不再把全部组合显示为相同的“选择 N 张卡片”。
- 同名卡通过候选序号保持可区分；超大选择集继续使用原有 factorized 分页提交机制，避免组合爆炸。
- 新增 6 个候选选 2 张的 30 组合回归测试，并验证模型可见的合法动作输出中全部标签唯一。

## 1.0.1 — 2026-08-14

- 修复卡库更新的跨盘 EXDEV：数据根目录（cache/replays/routes/decks）默认改为 `$DSH_HOME/ygoai`，确保与插件资源目录同盘，更新器可以完成原子 rename。
- 导出 `resolvePluginConfig` 便于集成测试。

## 1.0.0 — 2026-08-14

首个 DeepSeek Harness 发布版。

- 内嵌完整 YGOagentskill v1.0.0（backend、runtime、resources、vendor、references、integrations、tests、examples）。
- DSH 插件 `ygoai`：注册完整模型工具集与 `ygoagentskill` skill（带 references 资源基目录）。
- 热拔插引擎：薄客户端 + detached 引擎主机进程（127.0.0.1:19981），按需启动、显式主机停机、崩溃后自动重启。
- 会话按 DSH agent id 隔离（`dsh-<agentId>`），跨插件重载与 DSH 重启保留（引擎进程存活期内）。
- 输入 schema 从后端 JSON Schema 转换为 DSH 参数 DSL，权威校验仍在引擎主机。
- 输出目录（cache/replays/routes/decks）默认落在 `~/.dsh/ygoai`，全部可通过配置或环境变量覆盖。
