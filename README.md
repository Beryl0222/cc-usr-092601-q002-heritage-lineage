# 非遗制式与衍生谱系库

描述非遗制式、作品批次、师承授权与公开说明之间的谱系事件。

## 目录

- `contracts/domain.schema.json`：对象、事件和载荷字段约定。
- `data/sample.json`：可直接校验的联调样例。
- `src/`：基础契约校验、谱系服务、持久化与命令行入口。
- `tests/`：信封、时间、版本、事件载荷与服务规则测试。
- `docs/domain.md`：领域对象、事件语义与服务层规则。

## 服务层

- `src/service.js`：谱系服务，负责业务幂等、冲突隔离与状态推进——双签认定、设计冻结、授权收窄/撤回/到期处置、批次数量守恒、作品回执幂等、定期任务与恢复，以及消费者/授课机构/内部审计三种最小必要视图。
- `src/store.js`：事件与定期任务计划的持久化，内存实现用于测试，JSON 文件实现用于进程重启后恢复。

## 命令行

```bash
node src/cli.js audit <store.json> <work_id>        # 从作品回看工序、师承、贡献与历次公开身份
node src/cli.js view consumer <store.json> <work_id>
node src/cli.js view institution <store.json> <course_id>
node src/cli.js sweep <store.json> <sweep_id> <planned_at>   # 恢复未完成任务后执行定期处置
```

## 测试

```bash
npm test
```

## 编译检查

```bash
npm run build
```

## 样例校验

```bash
npm run check:sample
```

样例有效时输出 `valid`；发现问题时逐行给出字段、代码和中文说明，并返回非零状态。
