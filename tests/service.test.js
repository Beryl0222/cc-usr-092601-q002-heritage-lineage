import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createLineageService } from "../src/service.js";
import { createMemoryStore, openFileStore } from "../src/store.js";

const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));

const T1 = "2026-09-01T09:00:00+08:00";
const T2 = "2026-09-15T09:00:00+08:00";
const T3 = "2026-10-01T09:00:00+08:00";
const UNTIL = "2030-01-01T00:00:00+08:00";

const makeService = (store = createMemoryStore()) => createLineageService({ store, schema });

async function seedStandard(service) {
  await service.recordStandard({
    standard_id: "std-1",
    name: "传统兔儿爷制式",
    designer_id: "designer-0",
    elements: [
      { element_id: "el-ear", name: "竖耳", origin: "清代造像" },
      { element_id: "el-flag", name: "靠背旗", origin: "戏曲扮相" },
    ],
    process_versions: [{ version_id: "pv-1", note: "手工彩绘工序" }],
    molds: [{ mold_id: "mold-1", source: "老模具作坊甲" }],
    now: T1,
  });
  await service.signStandard({ standard_id: "std-1", reviewer_id: "rev-craft", reviewer_kind: "craft", now: T1 });
  await service.signStandard({ standard_id: "std-1", reviewer_id: "rev-folk", reviewer_kind: "folklore", now: T1 });
}

async function seedDesign(service) {
  await seedStandard(service);
  await service.issueGrant({
    grant_id: "g1",
    grantor_id: "master-a",
    scope: { elements: ["el-ear", "el-flag"], process_versions: ["pv-1"], molds: ["mold-1"] },
    valid_until: UNTIL,
    now: T1,
  });
  await service.composeDesign({
    design_id: "d1",
    designer_id: "designer-1",
    standard_id: "std-1",
    element_refs: [{ element_id: "el-ear", element_version: 1 }],
    process_version: "pv-1",
    mold_refs: ["mold-1"],
    grant_ids: ["g1"],
    now: T2,
  });
}

test("传统制式认定须技艺与民俗独立双签，设计者不能自批", async () => {
  const service = await makeService();
  await service.recordStandard({ standard_id: "std-1", name: "传统兔儿爷制式", designer_id: "designer-0", now: T1 });
  await assert.rejects(
    service.signStandard({ standard_id: "std-1", reviewer_id: "designer-0", reviewer_kind: "craft", now: T1 }),
    (error) => error.code === "self_approval" && /设计者不能批准自己的作品/.test(error.message),
  );
  const draft = await service.signStandard({ standard_id: "std-1", reviewer_id: "rev-craft", reviewer_kind: "craft", now: T1 });
  assert.equal(draft.status, "draft");
  await assert.rejects(
    service.signStandard({ standard_id: "std-1", reviewer_id: "rev-craft", reviewer_kind: "folklore", now: T1 }),
    (error) => error.code === "not_independent",
  );
  const approved = await service.signStandard({ standard_id: "std-1", reviewer_id: "rev-folk", reviewer_kind: "folklore", now: T1 });
  assert.equal(approved.status, "approved");
});

test("新设计组合既有元素时冻结当时的来源和许可", async () => {
  const service = await makeService();
  await seedDesign(service);
  const frozen = service.getDesign("d1").license_snapshot[0];
  assert.equal(frozen.grant_id, "g1");
  assert.equal(frozen.frozen_at, T2);
  assert.deepEqual(frozen.scope.elements, ["el-ear", "el-flag"]);
  await service.narrowGrant({
    grant_id: "g1",
    remaining_scope: { elements: ["el-flag"], process_versions: ["pv-1"], molds: ["mold-1"] },
    effective_at: T3,
    reason: "授权人收回竖耳元素",
    now: T3,
  });
  const after = service.getDesign("d1").license_snapshot[0];
  assert.deepEqual(after, frozen, "授权收窄不改写设计冻结时的来源与许可");
  assert.deepEqual(service.getGrant("g1").scope.elements, ["el-flag"]);
});

test("授权收窄后停止后续生产与新课程，已售与已结束活动保留原依据", async () => {
  const service = await makeService();
  await seedDesign(service);
  await service.createBatch({ batch_id: "b1", design_id: "d1", quantity: 2, standard_version: 1, now: T2 });
  await service.registerWork({ work_id: "w1", batch_id: "b1", fingerprint: "fp-1", contributor_ids: ["c1"], now: T2 });
  await service.registerWork({ work_id: "w2", batch_id: "b1", fingerprint: "fp-2", contributor_ids: ["c1"], now: T2 });
  await service.markWorkSold({ work_id: "w1", now: T2 });
  await service.approveStatement({
    statement_id: "st-sold", channel: "retail", subject_type: "work", subject_id: "w1",
    text: "传统复原兔儿爷", basis: { grant_ids: ["g1"], standard_version: 1 }, now: T2,
  });
  await service.approveStatement({
    statement_id: "st-stock", channel: "exhibition", subject_type: "work", subject_id: "w2",
    text: "当代创新兔儿爷", basis: { grant_ids: ["g1"], standard_version: 1 }, now: T2,
  });
  await service.referenceCourse({ course_id: "course-old", org_id: "org-1", design_ids: ["d1"], scheduled_at: T2, now: T2 });
  await service.finishCourse({ course_id: "course-old", now: T2 });
  await service.approveStatement({
    statement_id: "st-course", channel: "course", subject_type: "course", subject_id: "course-old",
    text: "公益课堂课件", basis: { grant_ids: ["g1"] }, now: T2,
  });

  const result = await service.narrowGrant({
    grant_id: "g1",
    remaining_scope: { elements: ["el-flag"], process_versions: ["pv-1"], molds: ["mold-1"] },
    effective_at: T3,
    reason: "收回竖耳元素",
    now: T3,
  });
  assert.deepEqual(result.flagged, ["st-stock"]);
  assert.deepEqual([...result.preserved].sort(), ["st-course", "st-sold"]);
  assert.equal(service.getStatement("st-sold").status, "active", "已售作品保留原依据");
  assert.equal(service.getStatement("st-course").status, "active", "已结束活动保留原依据");
  assert.equal(service.getStatement("st-stock").status, "needs_correction", "在展说明需要补正");

  await assert.rejects(
    service.createBatch({ batch_id: "b2", design_id: "d1", quantity: 1, standard_version: 1, now: T3 }),
    /后续生产停止使用/,
  );
  await assert.rejects(
    service.referenceCourse({ course_id: "course-new", org_id: "org-2", design_ids: ["d1"], scheduled_at: T3, now: T3 }),
    /新课程停止使用/,
  );
});

test("批次拆分、合并和返工保持数量守恒", async () => {
  const service = await makeService();
  await seedDesign(service);
  await service.createBatch({ batch_id: "b1", design_id: "d1", quantity: 100, standard_version: 1, now: T2 });
  await assert.rejects(
    service.splitBatch({ batch_id: "b1", into: [{ batch_id: "x", quantity: 60 }, { batch_id: "y", quantity: 50 }], now: T2 }),
    (error) => error.code === "quantity_mismatch",
  );
  await service.splitBatch({ batch_id: "b1", into: [{ batch_id: "b1a", quantity: 60 }, { batch_id: "b1b", quantity: 40 }], now: T2 });
  assert.equal(service.getBatch("b1").status, "closed");
  await assert.rejects(
    service.splitBatch({ batch_id: "b1", into: [{ batch_id: "z", quantity: 100 }], now: T2 }),
    (error) => error.code === "batch_closed",
  );
  const merged = await service.mergeBatches({ from: ["b1a", "b1b"], batch_id: "b2", now: T2 });
  assert.equal(merged.quantity, 100);
  const reworked = await service.reworkBatch({ batch_id: "b2", into_batch_id: "b3", process_version: "pv-1", note: "重绘", now: T2 });
  assert.equal(reworked.quantity, 100, "返工不改变数量");
  assert.equal(service.getBatch("b2").status, "closed");
});

test("重复作品编号内容一致才沿用原回执，指纹或贡献人变化则锁定复核", async () => {
  const service = await makeService();
  await seedDesign(service);
  await service.createBatch({ batch_id: "b1", design_id: "d1", quantity: 3, standard_version: 1, now: T2 });
  const first = await service.registerWork({ work_id: "w1", batch_id: "b1", fingerprint: "fp-1", contributor_ids: ["c1"], now: T2 });
  const again = await service.registerWork({ work_id: "w1", batch_id: "b1", fingerprint: "fp-1", contributor_ids: ["c1"], now: T3 });
  assert.equal(again.reused, true);
  assert.equal(again.receipt_id, first.receipt_id, "内容完全一致时沿用原回执");

  const changedFingerprint = await service.registerWork({ work_id: "w1", batch_id: "b1", fingerprint: "fp-2", contributor_ids: ["c1"], now: T3 });
  assert.equal(changedFingerprint.status, "locked_for_review");
  assert.equal(service.getWork("w1").status, "locked_for_review");

  await service.registerWork({ work_id: "w2", batch_id: "b1", fingerprint: "fp-9", contributor_ids: ["c1"], now: T2 });
  const changedContributor = await service.registerWork({ work_id: "w2", batch_id: "b1", fingerprint: "fp-9", contributor_ids: ["c1", "c2"], now: T3 });
  assert.equal(changedContributor.status, "locked_for_review", "贡献人变化同样锁定复核");
});

test("定期任务发现授权到期和未完成处置，进程恢复后继续原计划", async () => {
  const store = createMemoryStore();
  const before = await makeService(store);
  await seedDesign(before);
  await before.issueGrant({
    grant_id: "g2",
    grantor_id: "master-b",
    scope: { elements: ["el-flag"], process_versions: ["pv-1"], molds: [] },
    valid_until: "2026-09-30T00:00:00+08:00",
    now: T2,
  });
  await before.createBatch({ batch_id: "b1", design_id: "d1", quantity: 1, standard_version: 1, now: T2 });
  await before.registerWork({ work_id: "w1", batch_id: "b1", fingerprint: "fp-1", contributor_ids: ["c1"], now: T2 });
  await before.approveStatement({
    statement_id: "st-1", channel: "retail", subject_type: "work", subject_id: "w1",
    text: "门店说明", basis: { grant_ids: ["g1", "g2"] }, now: T2,
  });
  await before.narrowGrant({
    grant_id: "g1",
    remaining_scope: { elements: ["el-flag"], process_versions: ["pv-1"], molds: ["mold-1"] },
    effective_at: T2,
    reason: "先收窄一次留下待补正",
    now: T2,
  });
  assert.equal(before.getStatement("st-1").status, "needs_correction");

  await before.planSweep({ sweep_id: "sweep-1", planned_at: T3 });
  // 模拟进程重启：同一存储、新的服务实例
  const recovered = await makeService(store);
  const resumed = await recovered.resumeSweeps();
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].status, "done");
  assert.equal(resumed[0].finished_at, T3, "恢复后按原计划时间执行");
  assert.deepEqual(resumed[0].findings.expired_grants, ["g2"]);
  assert.ok(resumed[0].findings.unfinished_dispositions.includes("st-1"));
  assert.equal(recovered.getGrant("g2").status, "expired");
  assert.equal((await recovered.resumeSweeps()).length, 0, "已完成的计划不重复执行");
});

test("审计命令从任一作品回看工序、师承、贡献和历次公开身份", async () => {
  const service = await makeService();
  await seedDesign(service);
  await service.recordContribution({ subject_id: "d1", contributor_id: "c1", role: "造型复原", now: T2 });
  await service.createBatch({ batch_id: "b1", design_id: "d1", quantity: 10, standard_version: 1, now: T2 });
  await service.splitBatch({ batch_id: "b1", into: [{ batch_id: "b1a", quantity: 4 }, { batch_id: "b1b", quantity: 6 }], now: T2 });
  await service.registerWork({ work_id: "w1", batch_id: "b1a", fingerprint: "fp-1", contributor_ids: ["c1"], now: T2 });
  await service.approveStatement({
    statement_id: "st-1", channel: "exhibition", subject_type: "work", subject_id: "w1",
    text: "当代创新", basis: { grant_ids: ["g1"] }, now: T2,
  });
  await service.narrowGrant({
    grant_id: "g1",
    remaining_scope: { elements: ["el-flag"], process_versions: ["pv-1"], molds: ["mold-1"] },
    effective_at: T3,
    reason: "收回竖耳元素",
    now: T3,
  });
  await service.correctStatement({ statement_id: "st-1", text: "经典元素再造（依据已更新）", now: T3 });

  const trace = service.auditTrace("w1");
  assert.equal(trace.work.receipt_id, "rcpt-w1");
  assert.equal(trace.process.current, "pv-1");
  assert.deepEqual(trace.batch_ancestors.map((batch) => batch.batch_id), ["b1"]);
  assert.equal(trace.lineage_grants[0].grantor_id, "master-a");
  assert.ok(trace.lineage_grants[0].history.some((entry) => entry.type === "narrowed"));
  assert.ok(trace.contributions.some((item) => item.contributor_id === "c1" && item.role === "造型复原"));
  assert.deepEqual(
    trace.public_identities[0].history.map((entry) => entry.status),
    ["active", "needs_correction", "corrected"],
    "历次公开身份完整可查",
  );
});

test("消费者与授课机构视图只含最小必要信息", async () => {
  const service = await makeService();
  await seedDesign(service);
  await service.createBatch({ batch_id: "b1", design_id: "d1", quantity: 1, standard_version: 1, now: T2 });
  await service.registerWork({ work_id: "w1", batch_id: "b1", fingerprint: "fp-secret", contributor_ids: ["c1"], now: T2 });
  await service.approveStatement({
    statement_id: "st-1", channel: "retail", subject_type: "work", subject_id: "w1",
    text: "传统复原", basis: { grant_ids: ["g1"] }, now: T2,
  });
  await service.referenceCourse({ course_id: "course-1", org_id: "org-1", design_ids: ["d1"], scheduled_at: T3, now: T2 });

  const consumer = service.consumerView("w1", T3);
  assert.deepEqual(Object.keys(consumer).sort(), ["basis_note", "origin", "public_identity", "recognition", "statement_status", "work_id"]);
  assert.equal(consumer.public_identity, "传统复原");
  assert.deepEqual(consumer.origin.elements, ["竖耳"]);
  const leaked = JSON.stringify(consumer);
  for (const secret of ["fp-secret", "contributor", "receipt", "grant_id", "license"]) {
    assert.ok(!leaked.includes(secret), `消费者视图不应包含 ${secret}`);
  }

  const institution = service.institutionView("course-1", T3);
  assert.equal(institution.teaching_allowed, true);
  assert.deepEqual(institution.lineage, [
    { design_id: "d1", grantor_id: "master-a", valid_until: UNTIL, current_status: "active" },
  ]);
  assert.ok(!JSON.stringify(institution).includes("fp-secret"), "机构视图不应包含作品指纹");
});

test("CLI 从文件存储恢复并输出审计谱系", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lineage-"));
  const storePath = join(dir, "store.json");
  const service = await createLineageService({ store: await openFileStore(storePath), schema });
  await seedDesign(service);
  await service.createBatch({ batch_id: "b1", design_id: "d1", quantity: 1, standard_version: 1, now: T2 });
  await service.registerWork({ work_id: "w1", batch_id: "b1", fingerprint: "fp-1", contributor_ids: ["c1"], now: T2 });

  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const out = execFileSync(process.execPath, [cli, "audit", storePath, "w1"], { encoding: "utf8" });
  const trace = JSON.parse(out);
  assert.equal(trace.work.work_id, "w1");
  assert.equal(trace.standard.name, "传统兔儿爷制式");
});
