# 领域约定

描述非遗制式、作品批次、师承授权与公开说明之间的谱系事件。

聚合对象包括`craft_standard`、`work_batch`、`lineage_grant`、`public_statement`。事件类型包括`STANDARD_RECORDED`、`GRANT_ISSUED`、`BATCH_CREATED`、`STATEMENT_APPROVED`、`GRANT_WITHDRAWN`。所有发生时间都必须携带时区，版本号从 1 开始递增，基础校验不会改写调用方输入。

## 事件载荷

- `GRANT_ISSUED`：载荷还需包含 `grantor_id`, `valid_until`。
- `BATCH_CREATED`：载荷还需包含 `quantity`, `standard_version`。
- `GRANT_WITHDRAWN`：载荷还需包含 `effective_at`, `reason`。

相同事件标识的业务幂等、冲突隔离和状态推进由上层服务负责；本仓库只定义可稳定交换的基础事实。
