# 领域约定

描述非遗制式、作品批次、师承授权与公开说明之间的谱系事件。

聚合对象包括 `craft_standard`（制式）、`derived_design`（衍生设计）、`lineage_grant`（师承授权）、`work_batch`（作品批次）、`work_item`（作品）、`public_statement`（公开说明）、`course`（课程引用）。所有发生时间都必须携带时区，版本号从 1 开始按聚合递增，基础校验不会改写调用方输入。

## 事件载荷

- `STANDARD_SIGNED`：`reviewer_id`, `reviewer_kind`（`craft` 技艺 / `folklore` 民俗）。
- `DESIGN_COMPOSED`：`designer_id`, `standard_id`, `element_refs`, `license_snapshot`（冻结当时的来源与许可）。
- `CONTRIBUTION_RECORDED`：`contributor_id`, `role`, `subject_id`。
- `GRANT_ISSUED`：`grantor_id`, `valid_until`。
- `GRANT_NARROWED`：`effective_at`, `remaining_scope`, `reason`。
- `GRANT_WITHDRAWN`：`effective_at`, `reason`。
- `GRANT_EXPIRED`：`expired_at`。
- `BATCH_CREATED`：`quantity`, `standard_version`。
- `BATCH_SPLIT`：`into`；`BATCH_MERGED`：`from`, `quantity`；`BATCH_REWORKED`：`from`, `quantity`, `process_version`。
- `WORK_REGISTERED`：`work_id`, `batch_id`, `fingerprint`, `contributor_ids`；`WORK_REVIEW_LOCKED`：`work_id`, `reason`。
- `STATEMENT_APPROVED`：`channel`, `subject_id`, `text`；`STATEMENT_FLAGGED`：`reason`；`STATEMENT_CORRECTED`：`text`。
- `COURSE_REFERENCED`：`org_id`, `design_ids`, `scheduled_at`。

## 服务层规则（`src/service.js`）

相同事件标识的业务幂等、冲突隔离和状态推进由服务层负责：

- **双签认定**：传统制式须由技艺与民俗两类审核者独立签署后才算认定；同一审核者只能签署一次，设计者不能批准自己的作品。
- **设计冻结**：新设计组合既有元素时，把当时的元素来源与许可（授权范围、授权人、有效期）冻结进 `license_snapshot`，后续授权变化不改写冻结内容。
- **授权收窄/撤回/到期**：后续生产与新课程引用被拒绝；已售作品与已结束活动的公开说明保留原依据；其余引用该授权的公开说明标记为需要补正。
- **数量守恒**：批次拆分、合并、返工前后数量必须相等，父批次随即关闭。
- **回执幂等**：重复作品编号只有在批次、指纹、贡献人完全一致时才沿用原回执；指纹或贡献人变化则锁定复核。
- **定期任务**：`planSweep` 先落库计划再执行，发现授权到期与未完成处置（待补正说明）；进程恢复后由 `resumeSweeps` 按原计划时间继续执行，已完成的不重复。
- **最小必要视图**：`consumerView`（公开身份、造型来源、认定情况、依据时效）、`institutionView`（课程计划、引用设计、师承来源、能否继续授课）、`auditTrace`（从任一作品回看批次谱系、工序、师承、贡献与历次公开身份）。
