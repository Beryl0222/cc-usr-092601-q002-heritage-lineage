import assert from "node:assert/strict";
import test from "node:test";

import * as D from "../src/domain.js";

// ---- 夹具：搭出一套已认定制式 + 有效授权 + 已批准设计 ----

function baseState() {
  let s = D.initialState();
  const step = (fn, input) => {
    const r = fn(s, input);
    const evs = r?.events ?? r;
    for (const e of evs) D.applyEvent(s, e);
    return r;
  };
  const at = (m, d = "01", h = "00:00:00") => `2026-${m}-${String(d).padStart(2, "0")}T${h}+08:00`;
  step(D.registerElement, { id: "e1", name: "骑虎", canonical_spec: {}, occurred_at: at("01") });
  step(D.registerElement, { id: "e2", name: "兔面", canonical_spec: {}, occurred_at: at("01") });
  step(D.recordMold, { id: "m1", origin: "老模", acquired_at: at("01"), occurred_at: at("01") });
  step(D.recordStandard, { id: "std1", name: "制式", tradition: "泥塑", version: 1, element_ids: ["e1", "e2"], process_version_ids: [], occurred_at: at("01", 2) });
  step(D.recordProcessVersion, { id: "p1", standard_id: "std1", version: 1, steps: ["a", "b"], occurred_at: at("01", 3) });
  step(D.signStandard, { id: "std1", standard_version: 1, reviewer_id: "rc", reviewer_kind: "craft", occurred_at: at("01", 4) });
  step(D.signStandard, { id: "std1", standard_version: 1, reviewer_id: "rf", reviewer_kind: "folklore", occurred_at: at("01", 4, "01:00:00") });
  step(D.issueGrant, {
    id: "g1",
    grantor_id: "master",
    grantee_id: "designer",
    scope: { element_ids: ["e1", "e2"], process_version_ids: ["p1"], mold_ids: ["m1"] },
    valid_from: at("01"),
    valid_until: "2027-01-01T00:00:00+08:00",
    occurred_at: at("01", 5),
  });
  step(D.freezeDesign, {
    id: "d1",
    designer_id: "designer",
    element_refs: ["e1", "e2"],
    process_refs: ["p1"],
    mold_refs: ["m1"],
    content_fingerprint: "fp-1",
    occurred_at: at("02"),
  });
  step(D.approveDesign, {
    id: "d1",
    approvals: [
      { reviewer_id: "rc2", reviewer_kind: "craft" },
      { reviewer_id: "rf2", reviewer_kind: "folklore" },
    ],
    occurred_at: at("02", 2),
  });
  return { state: s, step, at };
}

function drive(handler, state, input) {
  const outcome = handler(state, input);
  const events = outcome?.events ?? outcome;
  for (const e of events) D.applyEvent(state, e);
  return outcome;
}

// ---- 制式认定 ----

test("制式须技艺与民俗两类独立签署后才认定", () => {
  let s = D.initialState();
  drive(D.registerElement, s, { id: "e1", name: "x", canonical_spec: {}, occurred_at: "2026-01-01T00:00:00+08:00" });
  drive(D.recordStandard, s, { id: "std", name: "n", tradition: "t", version: 1, element_ids: ["e1"], process_version_ids: [], occurred_at: "2026-01-02T00:00:00+08:00" });
  assert.equal(s.standards.get("std").approved_version, null);
  assert.throws(
    () => drive(D.createBatch, s, { id: "b", quantity: 1, basis: { kind: "standard", id: "std" }, occurred_at: "2026-01-03T00:00:00+08:00" }),
    { code: "standard_not_recognized" },
  );
  drive(D.signStandard, s, { id: "std", standard_version: 1, reviewer_id: "rc", reviewer_kind: "craft", occurred_at: "2026-01-04T00:00:00+08:00" });
  assert.throws(
    () => drive(D.createBatch, s, { id: "b", quantity: 1, basis: { kind: "standard", id: "std" }, occurred_at: "2026-01-04T01:00:00+08:00" }),
    { code: "standard_not_recognized" },
  );
  drive(D.signStandard, s, { id: "std", standard_version: 1, reviewer_id: "rf", reviewer_kind: "folklore", occurred_at: "2026-01-05T00:00:00+08:00" });
  assert.equal(s.standards.get("std").approved_version, 1);
});

test("同一制式版本的同一类别不能由不同审核者重复签署", () => {
  const { state: s, step, at } = baseState();
  assert.throws(
    () => step(D.signStandard, { id: "std1", standard_version: 1, reviewer_id: "rc-other", reviewer_kind: "craft", occurred_at: at("02") }),
    { code: "independent_signature_required" },
  );
});

test("制式升级到新版本后旧签署失效，需要重新双签", () => {
  const { state: s, step, at } = baseState();
  step(D.recordStandard, { id: "std1", name: "制式", tradition: "泥塑", version: 2, element_ids: ["e1", "e2"], process_version_ids: ["p1"], occurred_at: at("05") });
  assert.equal(s.standards.get("std1").approved_version, null);
  assert.throws(
    () => step(D.signStandard, { id: "std1", standard_version: 1, reviewer_id: "rc", reviewer_kind: "craft", occurred_at: at("05", 2) }),
    { code: "version_mismatch" },
  );
});

// ---- 设计冻结与批准 ----

test("冻结时无有效许可的来源被拒绝", () => {
  const { state: s, at } = baseState();
  assert.throws(
    () =>
      D.freezeDesign(s, {
        id: "d-nolicense",
        designer_id: "someone-else",
        element_refs: ["e1"],
        process_refs: [],
        mold_refs: [],
        content_fingerprint: "fp-x",
        occurred_at: at("02"),
      }),
    { code: "unlicensed_source" },
  );
});

test("设计者不能批准自己的作品；批准必须两类各一人", () => {
  const { state: s, at } = baseState();
  drive(D.freezeDesign, s, {
    id: "d2",
    designer_id: "designer",
    element_refs: ["e1"],
    process_refs: [],
    mold_refs: [],
    content_fingerprint: "fp-2",
    occurred_at: at("02", 5),
  });
  assert.throws(
    () =>
      drive(D.approveDesign, s, {
        id: "d2",
        approvals: [
          { reviewer_id: "designer", reviewer_kind: "craft" },
          { reviewer_id: "rf2", reviewer_kind: "folklore" },
        ],
        occurred_at: at("02", 6),
      }),
    { code: "designer_cannot_approve_own_work" },
  );
  assert.throws(
    () =>
      drive(D.approveDesign, s, {
        id: "d2",
        approvals: [
          { reviewer_id: "rc2", reviewer_kind: "craft" },
          { reviewer_id: "rc3", reviewer_kind: "craft" },
        ],
        occurred_at: at("02", 6),
      }),
    { code: "two_independent_approvals_required" },
  );
});

test("冻结快照不受后续授权收窄影响：快照记录当时许可", () => {
  const { state: s, step, at } = baseState();
  const before = s.designs.get("d1").grant_snapshot;
  assert.equal(before[0].withdrawn, false);
  step(D.withdrawGrant, { id: "g1", effective_at: at("06"), reason: "收窄", replaces_scope: { element_ids: ["e1"] }, occurred_at: at("05", 20) });
  const after = s.designs.get("d1").grant_snapshot;
  assert.equal(after[0].withdrawn, false, "冻结快照不被改写");
  assert.deepEqual(after[0].scope.element_ids, ["e1", "e2"]);
});

// ---- 数量守恒 ----

test("批次拆分必须数量守恒", () => {
  const { state: s, step, at } = baseState();
  step(D.createBatch, { id: "b1", quantity: 10, basis: { kind: "design", id: "d1" }, occurred_at: at("03") });
  assert.throws(
    () => step(D.splitBatch, { source_batch_id: "b1", splits: [{ batch_id: "x", quantity: 4 }, { batch_id: "y", quantity: 5 }], occurred_at: at("03", 2) }),
    { code: "quantity_not_conserved" },
  );
  step(D.splitBatch, { source_batch_id: "b1", splits: [{ batch_id: "b2", quantity: 4 }, { batch_id: "b3", quantity: 6 }], occurred_at: at("03", 2) });
  assert.equal(s.batches.get("b1").status, "split");
});

test("批次合并数量守恒且只能合并活动批次", () => {
  const { state: s, step, at } = baseState();
  step(D.createBatch, { id: "b1", quantity: 4, basis: { kind: "design", id: "d1" }, occurred_at: at("03") });
  step(D.createBatch, { id: "b2", quantity: 6, basis: { kind: "design", id: "d1" }, occurred_at: at("03", 1, "01:00:00") });
  assert.throws(
    () => step(D.mergeBatches, { id: "b3", source_batch_ids: ["b1", "b2"], quantity: 9, occurred_at: at("03", 2) }),
    { code: "quantity_not_conserved" },
  );
  step(D.mergeBatches, { id: "b3", source_batch_ids: ["b1", "b2"], quantity: 10, occurred_at: at("03", 2) });
  assert.equal(s.batches.get("b3").quantity, 10);
  assert.throws(
    () => step(D.mergeBatches, { id: "b4", source_batch_ids: ["b1"], quantity: 4, occurred_at: at("03", 3) }),
    { code: "quantity_not_conserved" },
  );
});

test("返工整批等量；已拆批次不能再返工", () => {
  const { state: s, step, at } = baseState();
  step(D.createBatch, { id: "b1", quantity: 5, basis: { kind: "design", id: "d1" }, occurred_at: at("03") });
  assert.throws(
    () => step(D.reworkBatch, { id: "b2", source_batch_id: "b1", quantity: 4, reason: "开脸瑕疵", occurred_at: at("03", 2) }),
    { code: "quantity_not_conserved" },
  );
  step(D.reworkBatch, { id: "b2", source_batch_id: "b1", quantity: 5, reason: "开脸瑕疵", occurred_at: at("03", 2) });
  assert.equal(s.batches.get("b2").basis.kind, "batch_rework");
});

// ---- 回执规则 ----

test("重复编号：完全一致沿用原回执；指纹或贡献人变化锁定复核", () => {
  const { state: s, step, at } = baseState();
  step(D.createBatch, { id: "b1", quantity: 5, basis: { kind: "design", id: "d1" }, occurred_at: at("03") });
  const first = step(D.registerItem, { id: "w1", batch_id: "b1", item_no: "TY-1", content_fingerprint: "fp", contributor_ids: ["a", "b"], occurred_at: at("03", 4) });
  assert.equal(first.receipt_id, "w1");
  const dup = step(D.registerItem, { id: "w2", batch_id: "b1", item_no: "TY-1", content_fingerprint: "fp", contributor_ids: ["b", "a"], occurred_at: at("03", 5) });
  assert.equal(dup.receipt_id, "w1");
  assert.equal(dup.events.length, 0);

  const fpChanged = step(D.registerItem, { id: "w3", batch_id: "b1", item_no: "TY-1", content_fingerprint: "fp2", contributor_ids: ["a", "b"], occurred_at: at("03", 6) });
  assert.equal(fpChanged.locked, true);
  assert.equal(fpChanged.events[0].event_type, "ITEM_REVIEW_LOCKED");
  assert.equal(fpChanged.events[0].payload.reason, "fingerprint_changed");
  assert.equal(s.items.get("w1").locks.length, 1);
  assert.throws(() => step(D.sellItem, { id: "w1", occurred_at: at("03", 7), sold_at: at("03", 7) }), { code: "item_locked" });

  const cChanged = drive(D.registerItem, s, { id: "w4", batch_id: "b1", item_no: "TY-9", content_fingerprint: "fp", contributor_ids: ["a"], occurred_at: at("03", 8) });
  assert.equal(cChanged.events.length, 1);
  const cConflict = drive(D.registerItem, s, { id: "w5", batch_id: "b1", item_no: "TY-9", content_fingerprint: "fp", contributor_ids: ["a", "c"], occurred_at: at("03", 9) });
  assert.equal(cConflict.locked, true);
  assert.equal(cConflict.events[0].payload.reason, "contributors_changed");
});

// ---- 授权收窄 ----

function narrowedState() {
  const fixture = baseState();
  const { state: s, step, at } = fixture;
  step(D.createBatch, { id: "b1", quantity: 5, basis: { kind: "design", id: "d1" }, occurred_at: at("03") });
  step(D.registerItem, { id: "w1", batch_id: "b1", item_no: "TY-1", content_fingerprint: "fp-1", contributor_ids: ["designer"], occurred_at: at("03", 4) });
  step(D.registerItem, { id: "w2", batch_id: "b1", item_no: "TY-2", content_fingerprint: "fp-1", contributor_ids: ["designer"], occurred_at: at("03", 5) });
  step(D.sellItem, { id: "w1", occurred_at: at("04"), sold_at: at("04") });
  step(D.approveStatement, { id: "st1", subject_ref: { kind: "item", id: "w1" }, audience: "consumer", context: "门店", title: "传统复原", claim: "c", occurred_at: at("04", 2) });
  step(D.citeCourse, { id: "c1", course_name: "公益课", provider_id: "ngo", citations: [{ kind: "item", id: "w1" }], occurred_at: at("04", 3) });
  step(D.endCourse, { id: "c1", ended_at: at("04", 20), occurred_at: at("04", 20) });
  // 收窄：e1 骑虎移出范围
  step(D.withdrawGrant, { id: "g1", effective_at: at("06"), reason: "收窄", replaces_scope: { element_ids: ["e2"], process_version_ids: ["p1"], mold_ids: ["m1"] }, occurred_at: at("05", 20) });
  return fixture;
}

test("授权收窄后停止生产、流通与新课程引用；已售事实保留", () => {
  const { state: s, step, at } = narrowedState();
  assert.throws(() => step(D.createBatch, { id: "b9", quantity: 1, basis: { kind: "design", id: "d1" }, occurred_at: at("06", 2) }), { code: "production_halted" });
  assert.throws(() => step(D.sellItem, { id: "w2", occurred_at: at("06", 2), sold_at: at("06", 2) }), { code: "sale_halted" });
  assert.throws(() => step(D.citeCourse, { id: "c9", course_name: "新课", provider_id: "x", citations: [{ kind: "design", id: "d1" }], occurred_at: at("06", 2) }), { code: "citation_halted" });
  assert.equal(s.items.get("w1").sold_at, at("04"));
});

test("到期（未显式收窄）同样停止新使用", () => {
  const { state: s, step } = baseState();
  step(D.createBatch, { id: "b1", quantity: 1, basis: { kind: "design", id: "d1" }, occurred_at: "2026-03-01T00:00:00+08:00" });
  assert.throws(
    () => step(D.createBatch, { id: "b2", quantity: 1, basis: { kind: "design", id: "d1" }, occurred_at: "2027-01-02T00:00:00+08:00" }),
    { code: "production_halted" },
  );
});

// ---- 定期发现与处置 ----

test("发现任务区分已售/未售与已结束/未结束，并对历史公开说法开立补正处置", () => {
  const { state: s, at } = narrowedState();
  const plan = D.planDiscovery(s, at("07"));
  const kinds = Object.fromEntries(plan.to_open.map((e) => [`${e.affected.kind}:${e.affected.id}`, e.affected.requires]));
  assert.equal(kinds["item:w1"], "correction");
  assert.equal(kinds["item:w2"], "stop_use");
  assert.equal(kinds["course:c1"], "correction");
  assert.equal(kinds["statement:st1"], "correction");
});

test("处置闭环：correction 必须附补正说明，stop_use 不需要", () => {
  const { state: s, step, at } = narrowedState();
  const run = step(D.runDiscovery, { run_id: "run-1", as_of: at("07"), occurred_at: at("07", 1, "01:00:00") });
  const sold = run.plan.to_open.find((e) => e.affected.id === "w1");
  const unsold = run.plan.to_open.find((e) => e.affected.id === "w2");
  assert.throws(
    () => step(D.resolveDisposition, { id: sold.id, resolution: "仅下架", occurred_at: at("07", 2), resolved_at: at("07", 2) }),
    { code: "correction_required" },
  );
  step(D.resolveDisposition, { id: unsold.id, resolution: "隔离库存", occurred_at: at("07", 2), resolved_at: at("07", 2) });
  assert.equal(s.dispositions.get(unsold.id).resolved_at, at("07", 2));
});

test("补正说明可在依据失效后开立并完整保留原依据", () => {
  const { state: s, step, at } = narrowedState();
  const run = step(D.runDiscovery, { run_id: "run-1", as_of: at("07"), occurred_at: at("07", 1, "01:00:00") });
  const sold = run.plan.to_open.find((e) => e.affected.id === "w1");
  step(D.approveStatement, { id: "corr1", purpose: "correction", disposition_id: sold.id, subject_ref: { kind: "item", id: "w1" }, audience: "public", context: "补正", title: "补正", claim: "原依据保留", occurred_at: at("07", 2) });
  const stmt = s.statements.get("corr1");
  assert.equal(stmt.purpose, "correction");
  assert.ok(stmt.basis.grants.length >= 1, "补正说明仍冻结原师承快照");
});

test("发现任务幂等：同一变化不会重复开立处置单", () => {
  const { state: s, at } = narrowedState();
  const run1 = D.runDiscovery(s, { run_id: "r", as_of: at("07"), occurred_at: at("07", 1) });
  for (const e of run1.events) D.applyEvent(s, e);
  const plan2 = D.planDiscovery(s, at("07", 2));
  assert.equal(plan2.to_open.length, 0);
  assert.ok(plan2.open_reminders.length >= 4);
});

test("进程恢复：RUN_STARTED 后崩溃，续跑沿用原计划且不重复开立", () => {
  const { state: s1, at } = narrowedState();
  const first = D.runDiscovery(s1, { run_id: "run-crash", as_of: at("07"), occurred_at: at("07", 1, "01:00:00") });
  // 只落 RUN_STARTED（计划持久化），随后崩溃。
  D.applyEvent(s1, first.events[0]);
  const resumed = D.runDiscovery(s1, { run_id: "run-crash", as_of: at("08"), occurred_at: at("07", 1, "02:00:00") });
  assert.equal(resumed.resumed, true);
  assert.deepEqual(resumed.plan, first.plan, "恢复后必须沿用崩溃前的原计划");
  for (const e of resumed.events) D.applyEvent(s1, e);
  const run = s1.runs.get("run-crash");
  assert.equal(run.finished, true);
  // 处置单数量恰好等于原计划数量。
  const opened = [...s1.dispositions.values()].filter((d) => d.run_id === "run-crash");
  assert.equal(opened.length, first.plan.to_open.length);
});

test("扫描运行的同聚合事件版本严格递增", () => {
  const { state: s, at } = narrowedState();
  const run = D.runDiscovery(s, { run_id: "run-v", as_of: at("07"), occurred_at: at("07", 1) });
  const runEvents = run.events.filter((e) => e.aggregate_type === "discovery_run");
  assert.deepEqual(runEvents.map((e) => e.version), [1, 2, 3]);
});
