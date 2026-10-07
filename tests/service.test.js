import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { readFile as readSingle } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { EventStore } from "../src/store.js";
import { LineageService } from "../src/service.js";
import { reduce } from "../src/domain.js";
import { auditView, consumerView, providerView } from "../src/views.js";

const schema = JSON.parse(await readSingle(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));

let dir;
let store;
let svc;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "heritage-service-"));
  store = new EventStore(join(dir, "events.jsonl"), schema);
  svc = new LineageService(store);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const d = async (name, input, opts) => svc.dispatch(name, input, opts);

test("服务端到端：登记到视图查询", async () => {
  await d("register_element", { id: "e1", name: "骑虎", canonical_spec: {}, occurred_at: "2026-01-01T00:00:00+08:00" });
  await d("record_mold", { id: "m1", origin: "老模", acquired_at: "2026-01-01T00:00:00+08:00", occurred_at: "2026-01-01T00:00:00+08:00" });
  await d("record_standard", { id: "std1", name: "制式", tradition: "泥塑", version: 1, element_ids: ["e1"], process_version_ids: [], occurred_at: "2026-01-02T00:00:00+08:00" });
  await d("record_process_version", { id: "p1", standard_id: "std1", version: 1, steps: ["x"], occurred_at: "2026-01-03T00:00:00+08:00" });
  await d("sign_standard", { id: "std1", standard_version: 1, reviewer_id: "rc", reviewer_kind: "craft", occurred_at: "2026-01-04T00:00:00+08:00" });
  await d("sign_standard", { id: "std1", standard_version: 1, reviewer_id: "rf", reviewer_kind: "folklore", occurred_at: "2026-01-04T01:00:00+08:00" });
  await d("issue_grant", { id: "g1", grantor_id: "master", grantee_id: "designer", scope: { element_ids: ["e1"], process_version_ids: ["p1"], mold_ids: ["m1"] }, valid_from: "2026-01-01T00:00:00+08:00", valid_until: "2027-01-01T00:00:00+08:00", occurred_at: "2026-01-05T00:00:00+08:00" });
  await d("freeze_design", { id: "d1", designer_id: "designer", element_refs: ["e1"], process_refs: ["p1"], mold_refs: ["m1"], content_fingerprint: "fp1", occurred_at: "2026-02-01T00:00:00+08:00" });
  await d("approve_design", { id: "d1", approvals: [{ reviewer_id: "rc2", reviewer_kind: "craft" }, { reviewer_id: "rf2", reviewer_kind: "folklore" }], occurred_at: "2026-02-02T00:00:00+08:00" });
  await d("create_batch", { id: "b1", quantity: 6, basis: { kind: "design", id: "d1" }, occurred_at: "2026-03-01T00:00:00+08:00" });
  await d("split_batch", { source_batch_id: "b1", splits: [{ batch_id: "b1a", quantity: 2 }, { batch_id: "b1b", quantity: 4 }], occurred_at: "2026-03-02T00:00:00+08:00" });
  await d("register_item", { id: "w1", batch_id: "b1a", item_no: "TY-1", content_fingerprint: "fp1", contributor_ids: ["designer", "artisan"], occurred_at: "2026-03-03T00:00:00+08:00" });
  await d("sell_item", { id: "w1", occurred_at: "2026-04-01T00:00:00+08:00", sold_at: "2026-04-01T00:00:00+08:00" });
  await d("approve_statement", { id: "st1", subject_ref: { kind: "item", id: "w1" }, audience: "consumer", context: "门店", title: "传统复原", claim: "c", occurred_at: "2026-04-02T00:00:00+08:00" });
  await d("cite_course", { id: "c1", course_name: "公益课", provider_id: "ngo", citations: [{ kind: "item", id: "w1" }], occurred_at: "2026-04-03T00:00:00+08:00" });
});

test("消费者视图回答来源、认可者与有效场合", async () => {
  const state = await svc.state();
  const view = consumerView(state, { item_no: "TY-1" }, "2026-05-01T00:00:00+08:00");
  assert.equal(view.origin.kind, "design");
  assert.equal(view.origin.classic_elements[0].name, "骑虎");
  assert.equal(view.recognized_by.length, 2);
  assert.equal(view.validity.status, "有效");
  assert.equal(view.public_claims[0].context, "门店");
});

test("授课机构视图标出可开课与引用状态", async () => {
  const state = await svc.state();
  const [view] = providerView(state, { provider_id: "ngo" }, "2026-05-01T00:00:00+08:00");
  assert.equal(view.can_use, true);
  assert.equal(view.citations[0].usable, true);
});

test("审计视图从作品回看工序、师承、贡献、批次谱系与公开身份", async () => {
  const events = await store.readAll();
  const state = reduce(events);
  const audit = auditView(state, events, { item_id: "w1" });
  assert.deepEqual(audit.item.contributor_ids, ["designer", "artisan"]);
  assert.equal(audit.design.design_id, "d1");
  assert.equal(audit.grants[0].grant_id, "g1");
  assert.equal(audit.processes[0].id, "p1");
  assert.equal(audit.molds[0].origin, "老模");
  const batchIds = audit.batch_genealogy.nodes.map((n) => n.batch_id);
  assert.deepEqual(batchIds.sort(), ["b1", "b1a"]);
  assert.equal(audit.public_identity_history[0].statement_id, "st1");
  assert.ok(audit.event_refs.length >= 5);
  // event_refs 必须是日志中真实存在的事件。
  const allIds = new Set(events.map((e) => e.event_id));
  for (const ref of audit.event_refs) assert.ok(allIds.has(ref.event_id));
});

test("command_id 幂等：重复提交不产生新事件并返回原回执", async () => {
  const before = (await store.readAll()).length;
  const r1 = await d(
    "register_item",
    { id: "w2", batch_id: "b1b", item_no: "TY-2", content_fingerprint: "fp1", contributor_ids: ["designer"], occurred_at: "2026-03-04T00:00:00+08:00" },
    { command_id: "cmd-001" },
  );
  const r2 = await d(
    "register_item",
    { id: "w2-different", batch_id: "b1b", item_no: "TY-2", content_fingerprint: "fp1", contributor_ids: ["designer"], occurred_at: "2026-03-04T00:00:00+08:00" },
    { command_id: "cmd-001" },
  );
  assert.equal(r2.idempotent_replay, true);
  assert.equal(r2.receipt_id, r1.receipt_id);
  const after = (await store.readAll()).length;
  assert.equal(after - before, 1);
});

test("存储拒绝违反契约的事件", async () => {
  const badStore = new EventStore(join(dir, "bad.jsonl"), schema);
  await assert.rejects(() => badStore.append([{ event_type: "NOPE" }]), /契约校验/);
});

test("存储拒绝过期版本号（乐观并发）", async () => {
  const events = await store.readAll();
  const state = reduce(events);
  // 手工构造一个版本号落后的事件。
  const stale = {
    // event_id 故意不占用既有编号，才能走到版本连续校验。
    event_id: "craft_standard:std1:stale-check",
    event_type: "STANDARD_SIGNED",
    aggregate_type: "craft_standard",
    aggregate_id: "std1",
    occurred_at: "2026-08-01T00:00:00+08:00",
    version: 1,
    payload: { standard_version: 1, reviewer_id: "x", reviewer_kind: "craft" },
  };
  await assert.rejects(() => store.append([stale]), /期望版本/);
});

test("收窄后扫描、补正闭环，消费者视图出现补正且保留原依据", async () => {
  await d("withdraw_grant", { id: "g1", effective_at: "2026-06-01T00:00:00+08:00", reason: "收回骑虎", replaces_scope: { element_ids: [], process_version_ids: ["p1"], mold_ids: ["m1"] }, occurred_at: "2026-05-20T00:00:00+08:00" });
  const run = await svc.runDiscovery({ run_id: "run-july", as_of: "2026-07-01T00:00:00+08:00", occurred_at: "2026-07-01T01:00:00+08:00" });
  const sold = run.plan.to_open.find((e) => e.affected.id === "w1");
  assert.equal(sold.affected.requires, "correction");
  await d("approve_statement", { id: "corr1", purpose: "correction", disposition_id: sold.id, subject_ref: { kind: "item", id: "w1" }, audience: "public", context: "补正", title: "补正说明", claim: "原依据保留", occurred_at: "2026-07-02T00:00:00+08:00" });
  await d("resolve_disposition", { id: sold.id, resolution: "已补正", correction_statement_id: "corr1", occurred_at: "2026-07-02T01:00:00+08:00", resolved_at: "2026-07-02T01:00:00+08:00" });

  const state = await svc.state();
  const view = consumerView(state, { item_id: "w1" }, "2026-07-05T00:00:00+08:00");
  assert.equal(view.validity.status, "已超出原授权范围");
  assert.equal(view.validity.sold_basis_retained, true);
  assert.equal(view.corrections[0].statement_id, "corr1");
});

test("崩溃恢复：只追加 RUN_STARTED 后续跑沿用原计划、不重复开立处置", async () => {
  const raw = (await readFile(join(dir, "events.jsonl"), "utf8")).trimEnd().split("\n").map(JSON.parse);
  // 崩溃副本具备七月运行前的全部历史，但没有任何 discovery_run / disposition 事件。
  const seeded = raw.filter((e) => e.aggregate_type !== "discovery_run" && e.aggregate_type !== "disposition");
  const seededState = reduce(seeded);
  const { runDiscovery } = await import("../src/domain.js");
  const first = runDiscovery(seededState, { run_id: "run-recover", as_of: "2026-07-01T00:00:00+08:00", occurred_at: "2026-07-01T01:00:00+08:00" });

  const recoverStore = new EventStore(join(dir, "crash.jsonl"), schema);
  await recoverStore.append(seeded);
  await recoverStore.append([first.events[0]]); // 计划已持久化，进程在此刻崩溃。

  const recoveredSvc = new LineageService(recoverStore);
  const result = await recoveredSvc.runDiscovery({ run_id: "run-recover", as_of: "2026-08-01T00:00:00+08:00", occurred_at: "2026-07-01T02:00:00+08:00" });
  assert.equal(result.resumed, true);
  assert.deepEqual(result.plan, first.plan);
  const finalState = await recoveredSvc.state();
  assert.equal(finalState.runs.get("run-recover").finished, true);
  const opened = [...finalState.dispositions.values()].filter((x) => x.run_id === "run-recover");
  assert.equal(opened.length, result.plan.to_open.length);
});
