# 领域约定

描述非遗制式、师承授权、经典元素、工序版本、模具来源、设计、作品批次、公开说明、课程引用与处置之间的谱系事件。

所有事实以**只追加事件**表达。事件信封字段：`event_id`、`event_type`、`aggregate_type`、`aggregate_id`、`occurred_at`（必须携带时区）、`version`（每个聚合从 1 开始连续递增）、`payload`。基础契约校验不会改写调用方输入；业务幂等、并发冲突和状态推进由 `src/domain.js` 与 `src/store.js` 负责。

## 聚合

| 聚合 | 含义 |
| --- | --- |
| `craft_standard` | 传统制式（带内容版本 `version`，修订后须重新双签） |
| `classic_element` | 经典元素及其规范形态（如兔面、骑虎） |
| `process_version` | 挂在制式下的工序版本与步骤 |
| `mold_source` | 模具来源（老模、传承、新制） |
| `lineage_grant` | 师承授权：授予人、被授予人、覆盖范围、有效期与收窄记录 |
| `design` | 新设计：冻结的来源引用、授权快照、指纹与双类批准 |
| `work_batch` | 作品批次：数量、依据（制式/设计/拆分/合并/返工） |
| `work_item` | 单件作品：编号、内容指纹、贡献人、售出时间与复核锁 |
| `public_statement` | 展陈/销售/补正等公开说法，含当时冻结的依据快照 |
| `course` | 授课机构对制式、设计或作品的引用 |
| `disposition` | 授权变化后的处置单：停用或补正 |
| `discovery_run` | 一次定期发现运行，其计划持久化以支持崩溃恢复 |

## 事件

`STANDARD_RECORDED`、`STANDARD_SIGNED`、`ELEMENT_REGISTERED`、`PROCESS_VERSION_RECORDED`、`MOLD_RECORDED`、`GRANT_ISSUED`、`GRANT_WITHDRAWN`、`DESIGN_FROZEN`、`DESIGN_APPROVED`、`BATCH_CREATED`、`BATCH_SPLIT`、`BATCH_MERGED`、`BATCH_REWORKED`、`ITEM_REGISTERED`、`ITEM_REVIEW_LOCKED`、`ITEM_SOLD`、`STATEMENT_APPROVED`、`COURSE_CITED`、`COURSE_ENDED`、`DISPOSITION_OPENED`、`DISPOSITION_RESOLVED`、`RUN_STARTED`、`RUN_ADVANCED`、`RUN_FINISHED`。

事件与聚合的归属、各事件的必填载荷见 `contracts/domain.schema.json` 中的 `aggregate_for_event` 与 `payload_required_by_event`。

## 核心不变量

### 认定与批准

- 传统制式认定须由 `craft`（技艺）与 `folklore`（民俗）两类审核者**各自独立签署**；只有两类齐备时 `approved_version` 才生效，此前不得按该制式投产。
- 制式修订为新版本后，旧签署不适用于新版本，必须重新双签。
- 新设计批准同样需要两类不同审核者；**设计者不能出现在批准人名单中**。
- 同一制式版本的同一类别已有某审核者签署后，另一人不能顶替签署（`independent_signature_required`）。

### 来源冻结

- 新设计组合既有元素时，`DESIGN_FROZEN` 校验每个元素、工序、模具在冻结时刻都有授予设计者的有效许可，并把当时的授权人、范围、有效期、收窄状态固化为 `grant_snapshot`。
- 快照不可变：授权事后收窄或到期不会改写设计冻结的事实，只影响“此后还能不能用”。
- 公开说明与课程引用在批准时通过 `basis` 冻结当时依据；事后任何说法都能回答“当时凭什么这么说”。

### 授权收窄与处置

- `GRANT_WITHDRAWN` 在 `effective_at` 起以 `replaces_scope` 替换授权范围；到期则范围清空。
- 收窄/到期**之后**：新批次生产（`production_halted`）、未售作品继续流通（`sale_halted`）、新课程引用（`citation_halted`）一律拒绝。
- **已售作品与已结束活动保留原依据**：售出/结束事实不回滚，由定期发现开立处置单，要求发布公开补正说明（`requires: correction`）；未售作品与未结束活动要求停用（`requires: stop_use`）。
- 补正说明（`purpose: correction`）允许在依据失效后开立，且仍完整冻结原依据；correction 类处置未附补正说明不能闭环。
- 补正说明不出现在消费者的常规说法列表中，而单独呈现为 `corrections`。

### 批次与作品

- 拆分：子批数量之和必须**恰好等于**来源批次数量，来源随即标记为 `split`。
- 合并：只能合并活动批次，数量必须等于各来源之和，来源标记为 `merged`。
- 返工：必须整批、等量，来源标记为 `reworked`。
- 作品登记在活动批次上，经批次链回溯到最初的制式或设计根依据（`batchRootBasis`）。
- 重复作品编号：只有**编号、内容指纹、贡献人集合完全一致**才幂等沿用原回执（不产生事件）；指纹或贡献人变化绝不另发回执，而是对原作品加 `ITEM_REVIEW_LOCKED`，锁定期间不得售出。

### 定期任务与恢复

- `planDiscovery(as_of)` 只产出计划：到期/收窄授权影响到的作品、课程、历史公开说法，以及既往**未完成处置**的提醒；同一“授权 × 变化点 × 对象”幂等，不重复开立。
- `runDiscovery` 先落 `RUN_STARTED`（内含完整计划），再开立处置单、`RUN_ADVANCED`、`RUN_FINISHED`。
- 进程在任意点崩溃后，以**同一 `run_id` 重跑**即从 `RUN_STARTED` 取回原计划继续，已开立的处置单跳过，不按当前时间重新规划。

## 三类最小必要视图（`src/views.js`）

- `consumerView`：造型从哪里来（元素、工序、模具、师承）、由谁认可（两类签署人）、当下有效场合、历次公开说法与补正。不暴露内部处置流水。
- `providerView`：课程每条引用当下是否可用、最早到期点、已结束保留原依据、待处理停用项。
- `auditView`：从任一作品（按 id 或编号）回看指纹与贡献人、根设计/制式、批准、授权与收窄、工序、模具、批次拆分/合并/返工谱系、处置记录、历次公开身份以及对应的真实事件引用。

## 命令

服务门面 `LineageService.dispatch(name, input)` 支持的命令名见 `src/service.js` 的 `COMMANDS` 表。所有时间输入必须是带时区的 ISO 字符串；可选 `command_id` 提供请求级幂等，重复提交返回首次回执而不追加事件。
