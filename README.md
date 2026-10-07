# 非遗制式与衍生谱系库

把**师承授权期、经典元素、工序版本、模具来源、作品批次、设计贡献、展陈说明与课程引用**关联为可追溯的谱系事件，并分别向消费者、授课机构与内部审计提供最小必要信息。

## 目录

- `contracts/domain.schema.json`：聚合、事件、载荷字段与事件-聚合归属约定。
- `src/contracts.js`：事件信封基础校验（时间须带时区、版本为正整数、载荷必填）。
- `src/domain.js`：纯函数领域层。事件→状态归算与命令→事件的全部业务不变量。
- `src/store.js`：只追加 JSONL 事件存储（契约校验、聚合版本连续、`event_id` 唯一、`command_id` 幂等）。
- `src/service.js`：服务门面（命令分发、定时发现与恢复）。
- `src/views.js`：消费者 / 授课机构 / 内部审计三类视图。
- `src/cli.js`：命令行入口。
- `examples/walkthrough.mjs`：兔儿爷端到端示例。
- `tests/`：契约、领域不变量与服务端到端测试。
- `docs/domain.md`：领域对象、事件语义与不变量清单。

## 关键规则

- 传统制式认定须**技艺、民俗两类审核者独立签署**；设计者**不能批准自己的作品**；新设计须经两类不同审核者批准。
- 新设计冻结时**固定当时的每一项来源与许可快照**，事后授权变化不改写快照。
- 授权收窄/到期后，**后续生产与新课程停止使用**；**已售作品与已结束活动保留原依据**，并生成必须附带的公开补正说明。
- 批次拆分、合并、返工**数量守恒**（拆分之和等于来源、合并等于来源之和、返工整批等量）。
- 重复作品编号只有**内容指纹与贡献人完全一致**才沿用原回执；指纹或贡献人变化即锁定复核，不另发回执。
- 定期任务发现授权到期、收窄与未完成处置；运行计划先落盘，**进程恢复后沿用原计划**继续。
- 审计可从任一作品回看工序、师承、贡献、批次谱系、处置与历次公开身份。

## 测试

```bash
npm test
```

## 编译检查

```bash
npm run build
```

## 端到端示例

```bash
npm run demo
```

演示：双类签署 → 授权与设计冻结 → 不自批拦截 → 批次守恒与回执锁定 → 多场合公开说法 → 授权收窄停用 → 定时发现与补正闭环 → 崩溃恢复 → 三类视图。

## 命令行

```bash
# 校验单个事件（兼容旧用法 validate <schema> <event>）
node src/cli.js validate data/sample.json

# 执行领域命令（input 也可用 @文件路径）
node src/cli.js command --store data/runtime/events.jsonl \
  --name sign_standard \
  --input '{"id":"std-tuye","standard_version":1,"reviewer_id":"r1","reviewer_kind":"craft","occurred_at":"2026-01-06T10:00:00+08:00"}' \
  --command-id cmd-0001

# 三类最小必要视图
node src/cli.js view consumer --store ... --item-no TY-2026-0001 --as-of 2026-07-05T00:00:00+08:00
node src/cli.js view provider --store ... --course-id course-001 --as-of 2026-07-05T00:00:00+08:00
node src/cli.js view audit    --store ... --item-id item-0002

# 只看待开立的处置计划，或执行一次可恢复的定时发现
node src/cli.js plan --store ... --as-of 2026-07-01T00:00:00+08:00
node src/cli.js scan --store ... --run-id run-20260701 --as-of 2026-07-01T00:00:00+08:00
```

校验有效输出 `valid`；发现问题时逐行给出字段、代码和中文说明，并返回非零状态。
