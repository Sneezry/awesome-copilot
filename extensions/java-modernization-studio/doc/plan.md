# Java Modernization Studio UX 改进实施计划（执行中）

依据 [UX 审查及截图](appmodux-with-images.md) 的 16 条建议，并对照扩展实现。本文是**产品改进计划**，不是目标 Java 仓库中供扫描器读取的 `plan.md`。

## 实施进度（2026-11-02）

| 任务 | 状态 | 已做 / 尚需验收 |
| --- | --- | --- |
| T01 | 代码完成，宿主手动刷新已验，自动恢复待修复 | 逐项验证建议、完成状态及环境刷新/重连复检等自动化回归已通过；真实 app 的 `get_state`、`refresh` 环境重探测、SSE 状态推送和无效仓库报错已验。进度条已从仓库进度文件恢复并跨页面显示，当前刷新可见 17/18；此前重启后宿主保留旧面板但 runtime 未恢复实例，手工重开并刷新才恢复。自动恢复、无计划的真实页面、安装后无需重启的环境变化及真实任务自动同步仍待验 |
| T02 | 部分完成，JDK 安装后宿主复检已验 | JDK/Ant/未知构建判定、首屏引导、执行前复检及服务端门禁已通过自动化；真实 app 中缺 JDK 时执行按钮禁用，直接调用修复和 Autopilot 接口均被拦截。用户授权后安装 JDK 21 并配置用户环境变量，重启后的真实画布 `get_state` / `refresh` 均显示 ready；画布内引导代理安装的路径仍未验 |
| T03 | 新请求 CLI 配置与宿主展示已验，自动代理链路待验 | 画布生成请求专属的嵌套 CLI YAML 并要求干净副本执行，以原生报告元数据阻止错误目标获批。Java 21 全项目、Java 17 `web` 模块已分别在隔离副本实测；用户清理旧产物后，从真实画布提交新的全项目 Java 21/Azure 请求，在干净源码副本运行 CLI，原生报告匹配并写回。画布刷新显示报告 `current`、12 项发现关联 18 步计划；由排队的 `session.send` 代理回合自主完成整条链路及宿主自动同步仍待验 |
| T04 | 宿主隐藏指令验收失败，跟进消息误判已复检 | `session.send({prompt, displayPrompt})` 曾在真实 app 把完整内部 `prompt` 显示在聊天，而非短消息；自发送评估 prompt 曾触发意图钩子，错误提示仓库路径不合法。评估前言排除逻辑与画布上下文剔除逻辑均已随 13:20 重启加载，带画布上下文的“已重启”消息未再出现路径提醒；本次新画布按钮已成功提交代理请求，但未独立检查该回合的聊天可见性与意图钩子。自然语言唤起及隐藏指令依旧未通过 |
| T05 | 当前计划审批及执行进度已验，其余待验 | 受信计划编辑/保存、评估绑定审批、完成进度保留与更改后失效已通过自动化；目标项目画布现为 `planApprovalStatus=approved`、`17/18`（94%），仅最终完整性检查未勾选；编辑后失效、恢复和普通聊天路径尚未实际走查 |
| T06 | 部分完成，CLI/宿主报告已验 | 兼容现有 JSON 及统一报告 v1；新请求真实画布显示 12 项源码核实的发现及 12/12 计划关联。旧运行有 Java 25 目标偏差和 31 条旧 `.curato` 报告污染位置；新干净副本的 Java 21 原生报告为 97 条规则定位、无旧 `.curato` 定位及 76 条 CVE 候选。后续对 116 个已解析依赖核对公告范围，记录 10 个构件的 29 条受影响版本匹配；原生长规则描述的渐进披露、Mission Control 报告及代理聊天用语仍待验证 |
| T07 | 部分完成，已批准步骤逐项推进 | 稳定 finding/步骤关联、单项修复与只读解释、按批准范围逐步批量执行及中断/恢复已通过自动化；12 个报告发现全部关联 18 步计划中的对应步骤。首个 P0 和 Blob 步骤经真实画布单项入口推进；后续目标项目进度已到 `17/18`（94%），但这不是批量执行、原生 Skills 入口或失败恢复的宿主验收 |
| T08 | 部分完成，宿主页面只读走查已做 | Assess/Plan/Validate 三主标签、持续状态/下一步、全局 Readiness/Refresh/Autopilot 与可见 Stop、旧标签兼容及换行规则已通过自动化；真实 app 已打开画布并通过 Browser 检查其服务页面的主标签和窄屏无横向溢出。当前整理的 12 项发现降低了页面负担，但原生长报告仍会一次展开，宿主 iframe 的主题、键盘交互及运行中 Stop 仍待验 |
| T09 | 待品牌决定 | 正式客户名称尚未确认 |

实施中若宿主不提供所需能力，或原方案无法通过验收，请在本表和文末“偏离与待讨论”中记明原因及替代方案；不得标记为完成。

## 排序原则与现状

- 先保证状态与下一步建议可信，再让依赖检查成为执行前置；随后补齐评估配置、人工审批与按发现执行，最后收敛导航和品牌。重要度相近时优先低风险；高风险工作只有在支撑后续流程或决定入口可行性时提前。
- `extension.mjs` 已在 `session.idle` 时复检环境并通过 SSE 推送，Refresh 也会重新探测；`renderer.mjs` 根据未完成的验证门禁推荐下一项。建议 7、14 的代码与自动化已落实，仍需宿主端走查。
- `scan.mjs` 读取 `.appmod/assessment.json`、受来源校验的计划/进度文档并推导验证门禁；`catalog.mjs` 的 `relevant` 仍只看构建依赖签名，`renderer.mjs` 已移除平铺任务页、仅展示已映射发现的专用执行入口。原生 Skills 入口仍待宿主验证。
- `extension.mjs` 注册 canvas 和对话钩子，按当前工作目录识别 Java 项目后通过 SDK `canvas.open` 打开 Readiness；按钮通过 `server.mjs`/`prompts.mjs` 将完整指令和短消息交给 `session.send`（Autopilot 交给 `sendAndWait`）。真实宿主的自然语言唤起、时间线呈现以及默认 agent 的其他行为不能仅凭代码与 README 保证。
- 用 `java-migration-copilot-samples/asset-manager` 做了本地只读预检，随后在重启后的真实 app 会话中加载会话扩展、打开 `appmod-cockpit` 并调用画布动作；历史验收与之后的真实评估分别记录如下。当前评估与批准计划仍匹配，目标项目已逐项推进至 `17/18`（94%）；这只是目标项目的步骤进度，**不是**产品改进计划 T01–T09 的完成率。自然语言唤起、代理时间线、批量执行与宿主自动重连仍不能由画布状态动作代替验收。

## asset-manager 宿主只读验收（2026-10-30）

| 项目 | 实际结果 | 尚待验证 |
| --- | --- | --- |
| 发现与打开 | 当前会话加载 `session:java-modernization-studio`，声明 `appmod-cockpit`；带 `repoPath` 打开后状态指向 asset-manager，重新打开实例从无效仓库切回目标仓库后恢复正确状态 | 其他项目会话中的自然语言意图唤起 |
| 状态与刷新 | `get_state` 显示 Java 8 / Maven wrapper；安装前 JDK 不在 PATH 而 `blocked`，重启后的画布显示 JDK 21 与 `ready`，`refresh` 再次探测仍为 `ready`；SSE 收到与动作一致的状态时间戳；无效仓库刷新报错，切回目标仓库恢复；非法 tab 输入在打开前被拒绝 | 不重启 app 时安装依赖后的自动刷新、断线重连及真实任务结束后的状态同步 |
| 报告与导航 | 原生 `.github/modernize/assessment/report.json` 显示 134 项（87 mandatory、19 potential、28 optional）；来源提示、严重度筛选和 Assess/Plan/Validate 页面可用；尚无获批计划，五项验证门禁均未运行 | 报告信息的渐进披露、其他产品的报告对齐与真实评估产物 |
| 执行门禁 | 缺 JDK 时执行按钮禁用；直接 POST `fix_finding` 和 `autopilot_start` 都被服务端拒绝，没有发送代理指令 | 获批计划后的真实单项/批量执行、失败恢复及时间线 |

真实提供方页面在 Browser 的 372px 视口无横向溢出，但 134 张发现卡片同时呈现约 10.8 万字符的描述文字、页面约 7.1 万像素高；部分规则描述含原样 Markdown 标记及字面的 `\n`。这是 T06/T08 仍需解决的实际可用性问题。Browser 只观察同一提供方服务的页面，不能代替宿主 iframe 的主题/焦点及聊天时间线验收。这一次只读走查前后的目标仓库状态一致，当时尚未生成 `.appmod`。

用户随后明确授权配置本机 JDK：`winget --scope user` 不支持该安装包，因此使用微软官方已校验 SHA256 的 ARM64 OpenJDK 21.0.13.0.2 ZIP 安装到用户目录，并持久设置用户级 `JAVA_HOME`/`PATH`。安装后独立进程的 `runDoctor` 为 `ready`，但运行中的 app 仍继承旧 PATH；用户重启 app 后 `get_state` 及再次 `refresh` 均识别 Java 21、Maven wrapper，状态为 `ready`。这验证了重启后的状态恢复，不等于应用不重启即可从新环境变量热更新。此前尚未评估；后续用户授权后才生成下述新产物。

宿主画布变为 `ready` 后，无计划的原生报告原本将下一步显示为“Review findings against the plan”，但实际尚无可审查的计划；`renderer.mjs` 现把这种未绑定评估的报告定位为 Assessment review，引导先选择范围并运行评估，Plan 无当前关联评估时也仅提供评估入口。相关回归测试已通过；此项源码更新已随本次重启加载，但无计划的真实宿主页面尚未复验。

## asset-manager 首次评估与待审批计划（历史记录，已由用户清理）

- 画布从 Assess 发起 `module=.`、`targetJava=21`、`cloud=Azure`，评估请求 ID 为 `120329ac-0e92-404c-af9e-71790173a881`。在用户已授权生成报告和待审批计划的范围内，Modernize CLI 1.0.76 以 `--source` 指向该项目、`--output-path` 指向会话私有目录、`--delegate local` 运行两次；原有 `.github/modernize/assessment/report.json`（2026-04-01）没有被覆盖。
- 默认运行按 Java 升级/云就绪/安全生成 20 个规则家族和 76 条依赖 CVE **候选**；尚未核对依赖解析版本与适用条件，不能当作确认漏洞。第二次显式使用项目原有 `.github/appmod/appcat/assessment-config.yaml` 中的顶层 `targetRuntime: openjdk21`、Azure 目标和安全域，报告却记录 `capabilities: [openjdk25]`、仅 `cloud-readiness/java-upgrade` 两域，汇总仍推荐 Java 25 / Spring Boot 4。该报告有 20 个规则家族、128 个规则位置；其中 AWS region 的 31 个位置在先前的 `.curato` 报告，不是应用源码。现已在合成样本确认这是 CLI YAML 层级不符，不能把旧报告解释为 Java 21 目标下的确认结果。
- 对当前 POM、Java 源码、配置键名和已有测试逐项核实后，在**目标项目**新增 `.appmod/assessment.json`（12 项附真实路径的整理后发现）、根 `plan.md` 与 `progress.md`（同一请求 ID、18 个稳定步骤，只有评估步骤勾选）。Java 21 / Azure 是用户选择的拟议方案，原生 CLI 的 Java 25 建议作为待解决偏差明确保留；原生报告不直接写入目标仓库。尚无 `plan-approval.json`，未批准、未执行修复、未修改应用源码。
- 真实 `appmod-cockpit` 对目标项目 `refresh`、`get_state` 均返回 `doctor=ready`、`reportStatus=ready`、`reportConfigStatus=current`、`planConfigStatus=current`、12/12 发现关联、计划进度 `1/18`（6%）、`planApprovalStatus=missing`，五项验证门禁均为 pending；尚未走批准与执行路径。扩展回归 209 项通过。原有 19 个未跟踪文件完整保留，新增的只有本次评估配置、报告和两份计划文档。
- 实际点击画布评估时，宿主忽略了 `displayPrompt` 的短消息意图，聊天显示完整内部 prompt；该自发送消息再经 `onUserPromptSubmitted` 被误判为包含外部路径的用户请求。评估前言排除逻辑已随 13:10 的 app 重启加载（会话副本与源码一致、新提供方启动晚于文件同步），但未重新发起评估，尚不能宣称真实自发送链路通过。重启后的“app 已重启”跟进消息仍出现路径提醒；按该消息附带的 `<canvas-context>`、`<system_reminder>` 构造输入，能复现普通消息被 Java 标题和 URL 误触发。`intent.mjs` 现在仅从单独成块的宿主上下文中剔除这些标记，保留用户正文中的路径检查；新修复的自动化回归已通过，运行中的提供方尚未加载它。重新打开原画布并 `get_state` / `refresh` 后仍是原请求 ID、12 项发现、进度 1/18、审批缺失、五项门禁 pending，未重新评估或修改应用源码。**完整 prompt 的可见性仍是宿主阻塞，不能标记为通过。**
- 13:20 重启后，新提供方进程的启动时间晚于修复文件同步时间，会话副本 `intent.mjs` 与源码哈希相同；这次同样附带 `<canvas-context>` 的“已重启”消息未出现此前的路径提醒。不过，宿主仍显示旧画布面板，runtime `canvas.action.invoke` 却报告没有打开的实例、旧画布端口没有监听；使用原实例 ID 和明确的 `asset-manager` 路径手工重新 `open_canvas` 后，`refresh` 返回原请求 ID、12 项发现、进度 1/18、审批缺失和五项 pending 门禁。没有重新评估、批准计划或改动应用代码。该次重启**不能**作为画布自动重连成功的证据；真实自发送提示词和隐藏指令路径亦未重测。

## Modernize CLI 1.0.76 配置契约核实（2026-10-30）

- [CLI 官方 README](https://github.com/microsoft/modernize-cli/blob/v1.0.76/README.md#L143-L150) 确认 `modernize assess --assess-config <path>` 显式读取 YAML，未指定时从 `.github/modernize/assessment/reports/assessment-config.yaml` 自动发现；旧 `.github/appmod/appcat/assessment-config.yaml` 不在该默认位置。官方 [CLI 参考](https://learn.microsoft.com/en-us/azure/developer/github-copilot-app-modernization/modernization-agent/cli-commands#assess) 和 [Batch Assessment](https://learn.microsoft.com/en-us/azure/developer/github-copilot-app-modernization/modernization-agent/batch-assess) 介绍可选的 Java 目标版本、安全域与 CVE 门槛，却没有逐字段 YAML schema。本机已有的 `~/.modernize/assessment-config.yaml` 将 `analysisCoverage` 放顶层、Java 选项放 `java:`、CVE 选项放 `security:`；这是已用 CLI 1.0.76 实测验证的 YAML 结构，不能把[官方 Assessment 插件](https://github.com/microsoft/github-copilot-modernization/blob/main/plugins/github-copilot-modernization/skills/assessment/SKILL.md)的扁平 `config` 对象直接当成 CLI YAML。
- 在会话私有目录创建三个不含目标源码的最小 Maven/Java 8 样本，并始终指定独立 `--source`、`--assess-config`、`--output-path`。原项目配置还将 Azure 目标写为单数 `targetComputeService`，而生效字段是 `java.targetComputeServices` 列表。使用错误层级的旧式顶层 `targetRuntime`/`assessmentDomains` 或扁平 `domains`/`targetComputeServices`，命令仍退出 0，但报告均是 `mode=issue-only`、`capabilities=[openjdk25]`、仅云就绪和 Java 升级、三个默认 Azure 服务、两个默认 OS，且无 `security` 字段；只有顶层 `analysisCoverage` 被采纳。故**退出成功不等于请求参数生效**。
- 改为以下实际复验过的嵌套结构，报告记录 `capabilities=[openjdk21]`、`domains=[java-upgrade,cloud-readiness,security]`、`targetIds=[azure-appservice]`、`os=[linux]`、`mode=issue-only`、`minimumCveSeverity=high`，且有 `security` 字段（合成样本无依赖漏洞，结果为空）。CLI 会拒绝无效的 `analysisCoverage` 并列出 `issue-only`、`full` 两个合法值，但不会拒绝位置错误的目标/域字段。`cveScanScope` 和 `enableContainerization` 出现在用户配置中，本轮报告没有可独立验证其作用的证据，不能标记为已验。

  ```yaml
  analysisCoverage: issue-only
  security:
    minimumCveSeverity: high
    cveScanScope: direct
  java:
    assessmentDomains:
      - java-upgrade
      - cloud-readiness
      - security
    targetRuntime: openjdk21
    targetComputeServices:
      - azure-appservice
    targetOS:
      - linux
    enableContainerization: false
  ```

- 即便 `--output-path` 指向会话目录，CLI 仍在**来源项目**写出 `.github/modernize/assessment/...` 和 Maven `target/`（在合成样本中已观察），因此针对 `asset-manager` 的后续原生评估使用干净的临时工作副本，排除旧 `.curato` 报告等污染项；执行结果见下一节。原项目现有评估 ID、12 项报告、18 步计划及未审批状态不变。

## T03 配置修复与真实隔离验收（2026-10-30）

- `assessment-cli.mjs` 根据画布的 Java 17/21、Azure 选择生成 CLI 1.0.76 已验证的嵌套 YAML（Java 升级、云就绪、安全域；App Service/AKS/Container Apps；Windows/Linux；`issue-only`、CVE 最低 high）；文件还写入 `cveScanScope: direct`，但原生报告没有该字段的独立验收证据。`server.mjs` 在写入 `.appmod/assessment-config.json` 的同时生成独立的 `.appmod/assessment-cli-<id>.yaml`；代理提示必须对干净副本的所选模块显式指定 `--source`、该 YAML 的 `--assess-config`、请求专属的 `--output-path` 和 `--delegate local`。发送失败时恢复旧设置并删除新 YAML。
- CLI 产物中的原始 `report.json` 逐字节复制到 `.appmod/native-assessment/<id>/report.json`；`scan.mjs` 校验生成的 YAML 未变、原生报告在本次请求之后开始且已完成、包含项目、安全域数组以及目标运行时/三个 Azure 服务/两个 OS/扫描模式/CVE 门槛。未满足则 `reportConfigStatus=unverified`、显示原因并阻断计划生成/批准和执行。旧的 `asset-manager` 整理报告本来已明确记载原生 CLI 运行 `openjdk25` 且遗漏安全域，新扫描器据此把其旧请求判为未验证，而不是继续因评估 ID 匹配而显示为 current。
- 本次 `asset-manager` 的已跟踪工作树无改动，用 `git archive HEAD` 创建两份不含旧 `.curato`、旧原生报告和旧 `.appmod` 的隔离副本，并由新 `start_assessment` 路径生成不同请求。真实 CLI 1.0.76 的 `--delegate local` 输出如下；两次均退出 0，原生报告与生成的 YAML 逐字段核验通过，复制的原生 JSON 与 CLI 输出 SHA256 相同。在隔离副本内另写**仅用于测试门禁**的空 findings 报告，扫描器均返回 `reportConfigStatus=current`、`planApprovalStatus=missing`；这不等于验证了真实代理自动生成发现/计划。两份原生报告、配置和 CLI 日志已保存在会话私有 `files/asset-manager-cli-contract-20261030/verified/`；临时源码副本及 ZIP 已清理。

  | 源码副本范围 / 目标 | 原生报告元数据 | 安全域结果 | 扫描门禁 |
  | --- | --- | --- | --- |
  | 全项目 `.` / Java 21 | `openjdk21`，三个域、三个 Azure 服务、Windows/Linux、`issue-only`、CVE high；项目名 `assets-manager-parent` | `security` 为数组，76 条待确认 CVE 候选；97 个规则定位，未混入旧 `.curato` 的 31 个位置 | `current`，审批 `missing` |
  | `web` 模块 / Java 17 | `openjdk17`，同样的域/服务/OS/模式/门槛；项目名 `assets-manager-web` | `security` 为数组、0 条匹配；不能据此推断其他模块安全 | `current`，审批 `missing` |

- 在用户清理和重新评估之前，扩展回归 `node --test --test-reporter=dot extensions\java-modernization-studio\test\cockpit.test.mjs`：215/215 通过，覆盖 YAML 字段层级、Java 17/21、模块命令、旧报告偏差、缺失/错误/过期原生报告、审批阻断、发送失败回滚和可见错误提示。当时原项目仍是请求 `120329ac-0e92-404c-af9e-71790173a881`，无审批文件和已跟踪应用源码修改。十个运行时 `.mjs`（含新增 `assessment-cli.mjs`）已同步到本会话扩展目录并逐一核对 SHA256。重启 App 并重开会话后，已通过画布 `get_state` / `refresh` 只读确认旧报告 `reportConfigStatus=unverified`、原因是原生 CLI 的 Java 目标或评估域不符、`planConfigStatus=current` 但 `planApprovalStatus=missing`；已用相同实例 ID 重开画布并聚焦 Assessment 标签。服务端和渲染逻辑均阻止旧报告的计划审批；该阶段尚未独立检查 iframe 的视觉呈现。不能把上述 CLI/本地测试当作 T04 或端到端验收通过。

## asset-manager 真实画布重新评估（2026-10-30）

- 用户手动清理旧 `.appmod/`、根 `plan.md`/`progress.md` 和 `.curato/` 后，确认已跟踪工作树无改动；旧 `.github/modernize/` 仍有历史原生报告，未用 `git reset` 或 `git clean` 清除它们。通过 Browser 在真实画布选择全项目 `.`、Java 21、Azure 并点击评估提交按钮，生成新请求 `9cbbe624-0513-42d5-b5ba-bf95538c7d32` 及嵌套的 CLI YAML；页面提示已发送给代理。这验证了表单、配置持久化和发送入口，不代表排队的代理回合已独立完成下列工作。
- 本回合依据上述请求，用 `git archive HEAD` 对 `asset-manager` 的 `317d3bb` 建立不含旧报告、`.appmod` 和构建产物的会话私有源码副本。Modernize CLI 1.0.76 在此副本运行 `assess --source <clean-copy> --assess-config <request-yaml> --output-path <request-output> --delegate local`，退出 0。原生报告 `status=Complete`，`analysisStartTime` 晚于请求时间，`capabilities=[openjdk21]`，域为 Java 升级/云就绪/安全，目标包含三个 Azure 服务及 Windows/Linux，`mode=issue-only`、`minimumCveSeverity=high`；97 条规则定位中没有旧 `.curato` 路径，安全数组中有 76 条待核查 CVE 候选。`cveScanScope` 与 `enableContainerization` 仍无法从报告独立验证。已在会话私有 `files/asset-manager-e2e-9cbbe624-0513-42d5-b5ba-bf95538c7d32/` 留存原生报告、配置、整理产物与 CLI 日志，并清理临时源码副本及 ZIP。
- 将原生 `report.json` 逐字节复制到该请求的 `.appmod/native-assessment/<id>/report.json`（SHA256 `C2C95FFF7808365271E45877A197EB9A6529654FA15D0F2F63938E40C14EC6C8`），据新报告和已跟踪源码重新整理 12 项发现，生成同一请求 ID 的 18 步 `plan.md` / `progress.md`。真实画布 `refresh` 返回 `reportConfigStatus=current`、`planConfigStatus=current`、12/12 发现关联、进度 1/18（6%）、`planApprovalStatus=missing`、Readiness `ready`，五项验证门禁 pending；Browser 实际页面显示 `Assess (12)`、`Plan (18)`、审批待办和禁用的执行按钮。未点击审批，未执行迁移、未修改任何已跟踪应用源码，也未提交或推送。
- 本次 CLI 运行、报告核验和整理产物由当前助手在已收到用户授权的回合中完成，不得把它误记为 `session.send` 排队代理回合**自主**完成了按钮→原生评估→发现/计划生成全链路。该链路、聊天隐藏原始 prompt、宿主自动同步和 Java 17 的真实画布模块流程仍待独立验收；旧 Java 25 请求仅作为历史记录，不再可用于审批。

## asset-manager 当前计划审批（2026-10-30）

- 用户在真实画布批准了请求 `9cbbe624-0513-42d5-b5ba-bf95538c7d32` 的当前计划；`.appmod/plan-approval.json` 记录的评估 ID、全项目 Java 21/Azure 范围和计划哈希与扫描结果一致。画布 `refresh` 返回 `planApprovalStatus=approved`、`reportConfigStatus=current`、`planConfigStatus=current`，Browser 页面显示 Approved 和两个可用的 P0 “Work on this” 按钮，进度仍为 1/18（6%）。用户选择后已点击首个 P0 的 “Work on this”，页面显示 “Sent to the agent: Work on step” 及等待代理处理；此时尚未收到执行结果、未修改已跟踪的应用源码，也未点击批量执行。
- 该按钮发送的单项步骤在排队回合中实际执行：父 `pom.xml` 将 Java 目标 8 改为 21；变更前 `worker` 的已有测试因 mock AWS SDK 的 final 响应流而报错，改为使用真实内存响应流并断言下载字节后，基线测试通过。初次 `.\mvnw.cmd -B -q verify` 沿用旧 Java 8 class 文件，不能作为升级验收；随后 `.\mvnw.cmd -B -q clean verify` 构建 `web` 与 `worker` 均通过，`javap` 确认两个模块入口类均为 major 65（Java 21），4 个 `worker` 测试通过。`progress.md` 仅勾选对应步骤并记录结果；画布刷新显示 `2/18`（11%）、审批仍 `approved`、报告与计划仍 `current`。未执行 Spring Boot 升级、云服务迁移或其他步骤，未提交或推送；这一轮证明首个单项按钮→代理→进度回写可行，不等于批量执行/中断恢复已验。
- 第二个 P0 单项回合中，用户在样例既定的 3.x 路径和当前开源支持中的 4.1.2 之间选择 Spring Boot 3.5.16。3.5.x 已过开源支持期，只有具备相应企业支持才满足“受支持”；本轮未核实该资格。父 POM 升级到 3.5.16，`web`/`worker` 继续共享其依赖管理；为能在 Spring Framework 6 上编译，将两模块 JPA、生命周期注解以及 Web MVC 拦截器/Servlet 的必要 API 改为 Jakarta/当前接口，未迁移其他服务。`.\mvnw.cmd -B -q clean verify` 通过，两个模块的入口 class 均为 Java 21 major 65，4 个 `worker` 测试通过，`web` 仍无现有测试。画布刷新显示 `3/18`（17%）、报告/计划 `current`、审批 `approved`；P1 Jakarta 初始化/行为测试与其余所有验证门禁仍待执行，未提交或推送。
- 本次 P1 Jakarta 单项为两模块增加测试范围内的 H2 依赖及真实 JPA 映射/实体生命周期测试；隔离 Spring 上下文验证 `dev` profile 的两个本地服务执行 `@PostConstruct` 并创建目录，`web` 的 MockMvc 测试验证存储请求拦截及查看请求排除。未改动获批 `plan.md`；`.\mvnw.cmd -B -q clean verify` 通过，`web` 3 项、`worker` 6 项测试全部通过，两个模块入口 class 均为 Java 21 major 65，源码无 `javax.persistence`、`javax.servlet` 或 `javax.annotation` 残留。`progress.md` 仅勾选该单项；真实画布 `refresh` 显示进度 `4/18`（22%）、报告/计划 `current`、审批 `approved`，其余 14 项保持待办。未运行外部 PostgreSQL/RabbitMQ/S3 端到端集成，未提交或推送。
- 本次 P1 非 `dev` 存储单项以 Azure SDK BOM、Blob SDK 和 `DefaultAzureCredential` 替换 Web/Worker 的 S3 客户端，保留数据库 `s3Key`/`s3Url` 字段与原图/缩略图对象键，图片经应用 `/storage/view/{key}` 代理；嵌套键和保留字符的 URL 编码、原始字节、缩略图、消息确认及页面链接由测试覆盖。`.\mvnw.cmd -B -q clean verify` 通过，Web 15 项、Worker 12 项测试无失败，两模块入口 class 均为 Java 21 major 65，源码及 POM 无 AWS SDK 依赖。只在 `progress.md` 勾选该单项，获批 `plan.md` 和审批哈希未修改；真实画布 `refresh` 显示 `5/18`（28%）、报告与计划 `current`、审批 `approved`，其余 13 项仍待办。未接入真实 Azure/PostgreSQL/RabbitMQ，也未复制历史 S3 对象；未提交或推送。

## asset-manager 后续进度与未决验收（2026-11-02）

- 先前 `5/18` 是 10 月 30 日 Blob 步骤完成时的历史快照。当前真实画布 `get_state` 为 `17/18`（94%），`reportConfigStatus=current`、`planConfigStatus=current`、`planApprovalStatus=approved`；仅“逐项核对获批发现并记录未决事项”的最终完整性步骤待做。进度显示由目标项目 `progress.md` 重建，跨页进度条已恢复；先前的宿主重启自动重连失败尚未重新验证为修复。
- 目标项目已在独立仓库完成 Java 21 / Azure 方向的各项已勾选步骤；一致性检查直接对照旧源码并通过 48 项 Web/Worker 针对性测试，明确记录了既有 S3 消息切换、手动 schema/对象迁移及上传发布失败和缩略图删除失败的残留状态差异。**不能**把检查步骤已勾选解释为行为完全等价，也未在真实 Azure Blob、Service Bus 和 PostgreSQL 上完成切换验证。具体差异与待办以目标项目的 `progress.md` 为准；不因目标项目进度而将 T01/T04/T07 的未验收项标为完成。

## 优先级与依赖

下表为建议的**交付顺序**，重要度指用户价值，风险指实现及回归风险。T04 可先并行做宿主能力验证；T06 可与 T05 并行，但发布仍须通过所列依赖。

| 顺序 | 合并后的任务 | 对应建议 | 重要度 | 风险 | 必要依赖 / 提前理由 |
| --- | --- | --- | --- | --- | --- |
| T01 | 状态自动同步与准确的验证下一步 | 7、14 | 关键 | 中 | 无；当前错误状态会误导所有后续操作 |
| T02 | 引导式 Readiness 与执行前置门禁 | 4 | 关键 | 中 | T01；安装后必须能更新状态，阻止无效执行 |
| T03 | 可配置、可复现的评估 | 9 | 高 | 中 | T02；配置是生成可审批计划的输入 |
| T04 | 对话意图唤起与不暴露原始指令 | 6、8 | 关键 | 高（宿主） | T02；入口决定用户能否抵达流程，先验证宿主契约 |
| T05 | 可编辑计划与统一执行审批 | 13 | 关键 | 高 | T03；虽需改执行边界，却是批量任务的安全前提 |
| T06 | 对齐评估报告并统一对外术语 | 10、11 | 高 | 中 | T03；可与 T05 并行，需核对现有产品报告样式 |
| T07 | 发现驱动的单项/批量处理，收起任务与 Skills 专页 | 12、15、16 | 高 | 高 | T05、T06；有替代路径后才能删除旧列表 |
| T08 | 收敛导航、总览与重复信息 | 1、2、5 | 中高 | 中 | T02、T07；最终导航不能藏起唯一可用的执行入口 |
| T09 | 产品名称统一 | 3 | 低 | 低 | T08 及品牌确认；候选名不等于已批准名称 |

## 任务与验收

### T01 状态自动同步与准确的验证下一步（7、14）

- 改动：在 `extension.mjs`、`server.mjs`、`renderer.mjs`、`scan.mjs` 沿用现有 `session.idle` + SSE 链路；在环境修复、仓库切换、手动 Refresh 和连接恢复时按需重跑环境探针，而非每次渲染都执行昂贵检测。核查评估产物缺失/格式错误时的状态提示；能取得宿主进度事件则节流推送，不能取得则明确显示“运行中/等待产物”和上次更新时间，不虚报实时阶段。
- 同一状态源决定总览与 Validate 的下一步：已完成的 Build、Unit Tests、CVE 不再作为默认推荐；失败项提示重试，未完成项按实际门禁显示，全部完成后才提示交付。校正仅因 `summary.md` 存在就显示完成、或因任一门禁有记录就强推 Build 的误导情形。
- 验收：评估或安装依赖结束后，打开的 canvas 无须重开即可看到新状态；断线重连、显式 Refresh 和仓库切换不保留旧状态；截图中“三项已 Done 仍推荐 Build & Unit Test”的情形消失。为缓存失效、SSE 重连和门禁组合补 `test/cockpit.test.mjs` 回归测试。

### T02 引导式 Readiness 与执行前置门禁（4）

- 改动：`doctor.mjs` 区分阻断项与可选项，按项目实际 JDK/构建工具版本及 wrapper 判断；首次进入先呈现单一 Readiness 引导，完成后再进入 Assess/Plan/Validate。`server.mjs` 在动作分发层统一拦截需要工具链的执行动作和 Autopilot，不能只禁用按钮；只读检查及安全评估仍可按需访问。
- 引导中的 agent 先解释检测结果与可选方案，对 JDK/Maven 安装、PATH 修改等影响本机的操作逐项征得用户同意，优先使用已有工具或项目 wrapper；执行后复检并显示失败原因，不在未授权时静默安装。保留手动修复路径，可选 Docker/Azure CLI 不误判为全部流程阻断。
- 验收：缺 JDK/Maven 时从任何 canvas 执行入口都无法直接启动变更或绕过门禁；获准修复后复检变 Ready 并继续原流程；修复失败和仅缺可选项各有正确状态。覆盖 UI、直接调用 `/action`、Autopilot、仓库切换的测试。

### T03 可配置、可复现的评估（9）

- 改动：在 Assess 开始和重新评估前显示可核对的设置（仓库/模块范围、目标 Java/云平台、工具实际支持的选项）；先核实底层评估能力，未支持的开关不展示。`renderer.mjs` 收集设置，`server.mjs` 验证路径/枚举和仓库边界，`prompts.mjs` 传给评估流程；将本次配置与评估产物关联，重新评估时可回显。
- 评估结果、计划及后续动作引用同一版本的配置；目标或范围改变时标记旧报告/计划待复核，不能把旧批准沿用到新评估。缺少评估产物时给出明确失败/重试状态，不假装配置已经生效。
- 验收：不同范围和目标实际进入评估请求且可在结果中核对；非法路径/值被拒绝，默认值可用，重新评估后先前审批失效。补参数传递与产物兼容测试。

### T04 对话意图唤起与不暴露原始指令（6、8）

- 先做宿主能力验证：用当前 `@github/copilot-sdk`/默认 GitHub Copilot app 测试自然请求（如“帮我现代化这个 Java 应用”）能否路由到 `appmod-cockpit`，以及是否提供“可见短消息 + 不显示的详细指令”或等效 API；测试多仓库和无仓库场景。当前注册信息和 README 中的建议指令不能视为全局意图识别保证。
- 若宿主支持，则在 `extension.mjs` 的注册/激活链路和 `server.mjs`、`prompts.mjs` 的发送链路接入：自动定位仓库、打开 Readiness 后驱动 Assess，聊天中只显示可理解的简短意图；不再把完整 prompt 随 `/action` 响应回传 UI。长指令保留版本化测试，不靠删短指令牺牲执行正确性。
- 验收：默认 agent 下自然请求可稳定打开正确仓库的 canvas；按钮和 Autopilot 不在用户聊天中显示内部原始 prompt，仍能完成相同任务。若 SDK/宿主不支持，记录所需 API/产品依赖与复现用例，将自动唤起/隐藏指令标为**阻塞**；可先改进显式打开引导，但不得宣称两项已完成。

### T05 可编辑计划与统一执行审批（13）

- 改动：`renderer.mjs` 增加计划审阅与编辑（范围、目标、假设、默认步骤的取舍）、保存与明确批准；`scan.mjs` 选择当前受信的权威计划位置（优先 `.appmod/plan.md`，否则带来源标记的根 `plan.md`），避免编辑另一份文件却显示旧副本。保存时校验步骤标识/版本，保留 `progress.md` 已完成记录；审批绑定计划内容和评估配置的版本，变动后自动撤销审批。
- `server.mjs` 统一校验来自 `run_task`、`fix_finding`、`work_step`、`generate_tests`、Autopilot 等会修改应用的入口；未获批准只能查看/修改计划与评估，不得通过直接 POST、旧按钮或 `force` 参数绕过。执行中计划被外部更改须暂停并重新确认，不静默覆盖用户编辑。
- 验收：用户可更改并审阅关键决策；未批准时无代码变更路径，批准后只执行获批版本，编辑/重新评估/外部修改使批准失效；完成进度不因改名或重排错误丢失。测试并发更新和拒绝路径。对**绕过 canvas 的普通聊天执行**，须与 T04 一起验证宿主约束能力；扩展层不能单方面承诺全局拦截。

### T06 对齐评估报告并统一对外术语（10、11）

- 先以 Modernize CLI、Mission Control、VS Code 扩展的真实报告为对照，确定共用信息层次与字段含义；在 `scan.mjs` 归一化输出并在 `renderer.mjs` 呈现严重度、影响、文件位置、建议处理、处理状态/过滤，而不是重画一份不兼容报告。优先复用现有可用的模型/组件；若跨产品组件不可复用，记录一致的字段与交互契约。
- 同次修改 `renderer.mjs` 和 `prompts.mjs` 的客户可见标题、说明、评估计划及生成物指令，统一使用 “Assessment/评估” 等确定术语；内部工具/规则 ID 可继续保留，不盲目替换机器标识。对 agent 自由文本中的 “AppCAT” 需通过指令及验收用例验证，第三方工具日志不做误导性屏蔽。
- 验收：同一发现能从摘要逐层查看证据与建议操作，严重度/统计与来源报告一致；canvas、由本扩展触发的聊天和生成的用户可见标题不暴露内部产品名。对旧版或字段缺失的 `assessment.json` 仍可合理降级，补报告归一化测试。

### T07 发现驱动的单项/批量处理，收起任务与 Skills 专页（12、15、16）

- 改动：建立评估 finding ID 到已批准计划步骤/预定义任务的可核对映射；`catalog.mjs` 可作能力目录，**构建依赖命中不等于评估确认**。无评估时只引导评估；有评估时仅提供匹配发现的推荐及“修复此项”和“解释并由我决定”两条语义清楚的路径，必要时保留“无匹配，手动处理”。保留影响说明与文件证据。
- 在 `server.mjs`、`prompts.mjs`、`autopilot.mjs` 提供选择单项或“运行所有已批准的推荐项”：确认范围，按 P0→P2 和计划依赖排序，去重并逐项更新进度；遇到失败、需决策或审批失效即暂停，可恢复/取消，不把所有项拼成一条不可追踪的 prompt。替代路径可用后从 `renderer.mjs` 移走平铺的 Tasks & Skills 页和总览中的无关任务；保留 Skills 本身及 agent 使用能力，仅把创建/编辑/管理导向 GitHub Copilot app 的原生 `.github/skills` 入口（先确认可用设置链接，否则提供准确导航）。
- 验收：仅出现有证据支持的任务；单项与批量均遵守 T02/T05 门禁，部分失败可定位/继续；原生 Skills 可到达、既有技能文件不被删除；移除旧页后仍能完成用户原有的必要工作。覆盖未评估、无匹配、重复映射及批量中断的测试。

### T08 收敛导航、总览与重复信息（1、2、5）

- 在 `renderer.mjs` 将主导航收敛为 Assess、Plan、Validate；Readiness 是进入主流程前的引导，Overview 是持续可见的阶段/进度/阻塞/下一步区域，Summary 与执行记录在此按需展开。分支、Refresh、Autopilot 归入全局菜单或状态区，Autopilot 运行和停止状态仍必须随处可见；“Continue here”并入进度建议，不再重复占用一整卡。
- 清理头部标签、概览 Stack 和报告中无新增决策价值的重复信息；为窄屏、键盘操作和进行中状态保留明确入口，不为精简而藏起阻断、下一步或停止按钮。`extension.mjs` 的 `initialTab` 对旧值做跳转/兼容，必要时同步 README。
- 验收：首次进入能辨识当前阶段、阻断和唯一建议动作；三个主导航与各自内容对应，旧 tab 深链接不会白屏；总览没有重复的 Stack/任务/Autopilot 大卡，移动端和桌面端操作不丢失。用现有 renderer 测试及宿主截图走查。

### T09 产品名称统一（3）

- 品牌方先确认面向客户的正式名称（“Modernization Canvas”只是审查文档举例）；确认后统一更新 `extension.mjs`、`renderer.mjs`、`package.json` 描述及 README 中的可见名称和入口文案。保留 `appmod-cockpit`、动作种类、来源标记等持久/机器标识，除非另有兼容迁移方案。
- 验收：安装列表、canvas 标题、聊天引导与文档同名，旧实例/产物仍能识别；无品牌决定时此任务待定，不阻塞 T01–T08。

## 交付检查

每项代码任务都应在现有 `test/cockpit.test.mjs` 增加对应的状态/动作回归用例，运行 `node --test test/cockpit.test.mjs`；涉及默认 agent、宿主隐藏指令、原生 Skills、环境安装和视觉导航的情形还需在真实 GitHub Copilot app 中手动走通。验收时用同一 Java 仓库完整走一遍“自然请求 → Readiness → 配置评估 → 报告 → 编辑并批准计划 → 单项/批量处理 → 验证 → 总结”，并覆盖关闭/重开 canvas、SSE 重连、失败恢复及旧产物兼容。宿主不支持的能力应单独标注未完成，不能以页面层模拟代替。

## 16 条建议覆盖

| 建议 | 落地任务 | 建议 | 落地任务 |
| --- | --- | --- | --- |
| 1 信息架构 | T08 | 9 评估配置 | T03 |
| 2 信息过载 | T08 | 10 内部名 AppCAT | T06 |
| 3 产品命名 | T09 | 11 报告对齐 | T06 |
| 4 依赖前置 | T02 | 12 清晰处理任务 | T07 |
| 5 重复信息 | T08 | 13 可编辑计划 | T05 |
| 6 对话触发 | T04 | 14 验证引导准确 | T01 |
| 7 自动同步 | T01 | 15 移除平铺任务 | T07 |
| 8 不展示原始 prompt | T04 | 16 原生 Skills 管理 | T07 |

## 偏离与待讨论

- T02 的“代理实际安装依赖”不能靠本扩展的一条提示词证明已完成。目前实现要求代理先征得明确同意，随后使用宿主可用工具执行并复检；需要在真实 GitHub Copilot app 中验证安装能力和授权路径。若宿主不提供安全的安装能力，应新增带逐项确认的受控安装接口，或明确保留人工安装流程，不把“显示命令”标为完成。
- T03 的原 YAML 把 Java 字段误置顶层，导致 CLI 1.0.76 仍产出 `openjdk25`、漏掉安全域。现在画布生成独立的嵌套 YAML，扫描器用原生报告门禁防止因自述范围和 ID 匹配而误批准；`asset-manager` 的全项目 Java 21 与 `web` 模块 Java 17 已在隔离副本原生复评通过，旧请求被画布判为未验证。用户清理后，从真实画布提交的新全项目 Java 21 请求已由当前助手在干净副本完成原生评估和报告回写，当时画布显示已绑定报告及待审批计划，现已获批；尚不能推断排队代理回合会独立照办，也未在真实画布完成 Java 17 模块流程。T05 的审批/撤销机制仍单独验收。
- T04 的 SDK 1.0.4 `MessageOptions.displayPrompt` 参数已在按钮/Autopilot 传入，HTTP 响应亦不含 prompt，**但实际宿主聊天仍显示完整 `prompt`**，不能用类型声明推定其隐藏。扩展级 `onUserPromptSubmitted` + `canvas.open` 只对明确的 Java 应用现代化请求探测当前工作目录；画布自发的详细评估 prompt 曾再次进入钩子，导致错误的路径警告，其评估前言排除逻辑已随重启加载但尚未真实重放。跟进消息与宿主画布上下文相结合的误判已在测试中复现并修复，13:20 重启加载后的同类消息没有再次触发误报；剔除宿主块后仍会拒绝用户正文显式指定的其他路径。须在单仓库、多仓库、无仓库场景验证自然请求和钩子内打开/聚焦；若宿主不提供隐藏用户原始指令的契约，建议 8 保持阻塞，不能以另一个高优先级消息冒充原用户输入。
- T05 的审批只约束本扩展经 `/action` 发送的执行动作和 Autopilot；它不拦截绕过 canvas 的普通聊天或其他宿主代理工具。审批会随当前评估、计划内容或范围变化失效；完成勾选本身不撤销审批。保存前比较扫描时的计划与进度修订值，拒绝覆盖可检测到的外部更改；真实画布的当前计划审批已验，编辑、暂停和恢复仍待实际走查，不能宣称全局执行授权已实现。
- T06 参考本机已安装 VS Code 现代化扩展 1.24.0 的统一 `assessment-report.schema.json` v1：`projects[].incidents` 连接 `rules`，`security[]` 单列，来源严重度为 `mandatory/potential/optional/information`，不等同于本扩展报告的 P0–P3 规划优先级。历史运行中 31 条 AWS region 定位指向旧 `.curato` 报告；新全项目 Java 21 原生报告来自干净副本，没有旧 `.curato` 定位，含 76 条安全候选。后续核对 116 个已解析依赖及公告范围，记录 10 个构件的 29 条受影响版本匹配；尚未实施其余升级候选。原生报告只读显示、不可单凭整理报告证明当前评估配置，也不会自动批准计划；新 `.appmod/assessment.json` 经请求专属原生报告门禁后才绑定新 ID。尚无 Mission Control 可复用组件样本；渐进披露、规则描述渲染、代理实际聊天标题和第三方工具日志仍需宿主端走查。
- T07 的发现状态由当前计划及进度推导，推荐批量只执行明确关联且已批准的步骤；报告改变时暂停，预定义任务/Skill 不仅凭依赖命中运行。评估与生成计划指令要求 plan/progress 写入编码 finding ID 和稳定 step ID；本轮整理产物在真实宿主中达到 12/12 关联，但由代理依据已核实的源码和报告手工生成，不能推断下次按钮启动的代理一定遵从。未核实 GitHub Copilot app 可打开的原生 Skills 设置链接，因此 Plan 暂指向仓库 Skills 文件位置。用户已批准计划，目标项目已逐项推进至 17/18；批量执行、失败恢复、Skill 编辑及导航仍待实际验收。
- T08 的三标签、旧入口重定向与持续状态经过 HTML/CSS 和交互测试，另在本地假状态浏览器预览中检查 320/375/768/1280px 的溢出与 Stop 可见性、移动端菜单键盘展开；宿主浏览器的桌面/窄屏实际布局、键盘可达性和运行中 Stop 仍未走查，不能以假状态预览代替真实验收。