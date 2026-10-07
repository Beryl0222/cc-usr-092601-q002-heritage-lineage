#!/usr/bin/env node
// 兔儿爷端到端示例：从经典元素登记到授权收窄、定时处置、崩溃恢复与三类视图。
// 运行：node examples/walkthrough.mjs

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as domain from "../src/domain.js";
import { EventStore } from "../src/store.js";
import { LineageService } from "../src/service.js";
import { auditView, consumerView, providerView } from "../src/views.js";

const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
const dir = await mkdtemp(join(tmpdir(), "heritage-walkthrough-"));

const section = (title) => console.log(`\n=== ${title} ===`);
const expectReject = async (label, fn) => {
  try {
    await fn();
    console.log(`  [失败] 本应被拒绝：${label}`);
  } catch (e) {
    console.log(`  [已拒绝] ${label} -> ${e.code}`);
  }
};

const store = new EventStore(join(dir, "events.jsonl"), schema);
const svc = new LineageService(store);
const d = (name, input, opts) => svc.dispatch(name, input, opts);

section("1. 登记经典元素、模具、制式与工序版本");
await d("register_element", { id: "elem-face-rabbit", name: "兔面描金", canonical_spec: { feature: "三瓣嘴、金睛" }, occurred_at: "2026-01-02T10:00:00+08:00" });
await d("register_element", { id: "elem-mount-tiger", name: "骑虎造型", canonical_spec: { feature: "虎为座、腿分踞" }, occurred_at: "2026-01-02T11:00:00+08:00" });
await d("record_mold", { id: "mold-old-1908", origin: "清末老模翻制，藏于工坊联合会", acquired_at: "2025-12-01T00:00:00+08:00", occurred_at: "2026-01-03T10:00:00+08:00" });
await d("record_standard", { id: "std-beijing-tuye", name: "北京兔儿爷传统制式", tradition: "北京中秋节令泥塑", version: 1, element_ids: ["elem-face-rabbit", "elem-mount-tiger"], process_version_ids: [], occurred_at: "2026-01-04T10:00:00+08:00" });
await d("record_process_version", { id: "proc-tuye-v1", standard_id: "std-beijing-tuye", version: 1, steps: ["和泥醒泥", "老模压坯", "素烧", "彩绘开脸"], occurred_at: "2026-01-05T10:00:00+08:00" });

section("2. 传统制式认定：技艺与民俗两类审核者独立签署");
await expectReject("只有技艺类签署时按制式投产", async () => {
  await d("sign_standard", { id: "std-beijing-tuye", standard_version: 1, reviewer_id: "reviewer-craft-1", reviewer_kind: "craft", occurred_at: "2026-01-06T10:00:00+08:00" });
  await d("create_batch", { id: "should-fail", quantity: 1, basis: { kind: "standard", id: "std-beijing-tuye" }, occurred_at: "2026-01-06T11:00:00+08:00" });
});
await d("sign_standard", { id: "std-beijing-tuye", standard_version: 1, reviewer_id: "reviewer-folk-1", reviewer_kind: "folklore", occurred_at: "2026-01-07T10:00:00+08:00" });
console.log("  两类签署齐备，制式版本 1 生效");

section("3. 师承授权与新设计：冻结当时来源与许可");
await d("issue_grant", {
  id: "grant-shuangyan-2026",
  grantor_id: "master-shuangyan",
  grantee_id: "studio-linyan",
  scope: { element_ids: ["elem-face-rabbit", "elem-mount-tiger"], process_version_ids: ["proc-tuye-v1"], mold_ids: ["mold-old-1908"] },
  valid_from: "2026-01-01T00:00:00+08:00",
  valid_until: "2027-01-01T00:00:00+08:00",
  occurred_at: "2026-01-08T10:00:00+08:00",
});
await d("freeze_design", {
  id: "design-tuye-contemp",
  designer_id: "studio-linyan",
  element_refs: ["elem-face-rabbit", "elem-mount-tiger"],
  process_refs: ["proc-tuye-v1"],
  mold_refs: ["mold-old-1908"],
  content_fingerprint: "sha256:8f3c-a1b2",
  occurred_at: "2026-02-01T10:00:00+08:00",
});
await expectReject("设计者批准自己的作品", () =>
  d("approve_design", {
    id: "design-tuye-contemp",
    approvals: [
      { reviewer_id: "studio-linyan", reviewer_kind: "craft" },
      { reviewer_id: "reviewer-folk-1", reviewer_kind: "folklore" },
    ],
    occurred_at: "2026-02-02T10:00:00+08:00",
  }));
await expectReject("只有一类审核者批准", () =>
  d("approve_design", {
    id: "design-tuye-contemp",
    approvals: [{ reviewer_id: "reviewer-craft-1", reviewer_kind: "craft" }],
    occurred_at: "2026-02-02T11:00:00+08:00",
  }));
await d("approve_design", {
  id: "design-tuye-contemp",
  approvals: [
    { reviewer_id: "reviewer-craft-2", reviewer_kind: "craft" },
    { reviewer_id: "reviewer-folk-2", reviewer_kind: "folklore" },
  ],
  occurred_at: "2026-02-03T10:00:00+08:00",
});
console.log("  设计获批，来源与许可快照已冻结");

section("4. 批次拆分/合并守恒与作品回执规则");
await d("create_batch", { id: "batch-2026-001", quantity: 20, basis: { kind: "design", id: "design-tuye-contemp" }, occurred_at: "2026-03-01T10:00:00+08:00" });
await expectReject("拆分数量不守恒（8+7 != 20）", () =>
  d("split_batch", { source_batch_id: "batch-2026-001", splits: [{ batch_id: "bad-a", quantity: 8 }, { batch_id: "bad-b", quantity: 7 }], occurred_at: "2026-03-02T10:00:00+08:00" }));
await d("split_batch", { source_batch_id: "batch-2026-001", splits: [{ batch_id: "batch-2026-001-a", quantity: 8 }, { batch_id: "batch-2026-001-b", quantity: 12 }], occurred_at: "2026-03-02T11:00:00+08:00" });
await d("merge_batches", { id: "batch-2026-002", source_batch_ids: ["batch-2026-001-a", "batch-2026-001-b"], quantity: 20, occurred_at: "2026-03-03T10:00:00+08:00" });

const r1 = await d("register_item", { id: "item-0001", batch_id: "batch-2026-002", item_no: "TY-2026-0001", content_fingerprint: "sha256:8f3c-a1b2", contributor_ids: ["studio-linyan", "artisan-zhao"], occurred_at: "2026-03-04T10:00:00+08:00" });
const r2 = await d("register_item", { id: "item-0001-dup", batch_id: "batch-2026-002", item_no: "TY-2026-0001", content_fingerprint: "sha256:8f3c-a1b2", contributor_ids: ["artisan-zhao", "studio-linyan"], occurred_at: "2026-03-04T10:05:00+08:00" });
console.log(`  完全一致重复登记沿用原回执：${r2.receipt_id}（原回执 ${r1.receipt_id}），新事件 ${r2.event_ids.length} 条`);
await expectReject("同编号指纹不同 -> 锁定复核，不另发回执", async () => {
  const locked = await d("register_item", { id: "item-forged", batch_id: "batch-2026-002", item_no: "TY-2026-0001", content_fingerprint: "sha256:ffff-0000", contributor_ids: ["artisan-zhao", "studio-linyan"], occurred_at: "2026-03-05T10:00:00+08:00" });
  if (!locked.locked) throw new Error("应当锁定");
  await d("sell_item", { id: "item-0001", occurred_at: "2026-03-06T10:00:00+08:00", sold_at: "2026-03-06T10:00:00+08:00" });
});
await d("register_item", { id: "item-0002", batch_id: "batch-2026-002", item_no: "TY-2026-0002", content_fingerprint: "sha256:8f3c-a1b2", contributor_ids: ["studio-linyan", "artisan-zhao"], occurred_at: "2026-03-07T10:00:00+08:00" });

section("5. 同一件作品在不同场合的公开说法（各有冻结依据）");
await d("sell_item", { id: "item-0002", occurred_at: "2026-04-01T10:00:00+08:00", sold_at: "2026-04-01T10:00:00+08:00" });
await d("approve_statement", { id: "stmt-store-001", subject_ref: { kind: "item", id: "item-0002" }, audience: "consumer", context: "门店", title: "传统复原款", claim: "依清末老模与传统工序复原", occurred_at: "2026-04-05T10:00:00+08:00" });
await d("approve_statement", { id: "stmt-fair-001", subject_ref: { kind: "design", id: "design-tuye-contemp" }, audience: "trade_visitor", context: "文博会", title: "当代创新设计", claim: "在经典骑虎造型上做当代配色，已经双类批准", occurred_at: "2026-04-10T10:00:00+08:00" });
await d("cite_course", { id: "course-classroom-001", course_name: "社区公益课·兔儿爷从哪里来", provider_id: "ngo-heritage-classroom", citations: [{ kind: "item", id: "item-0002" }], occurred_at: "2026-04-15T10:00:00+08:00" });
await d("end_course", { id: "course-classroom-001", ended_at: "2026-04-20T16:00:00+08:00", occurred_at: "2026-04-20T16:00:00+08:00" });
// item-0001 在锁定前处于库存未售状态，保留它用于"未售停用"分支演示：
// 为了让收窄后存在已售与未售两类，把 item-0002 视为已售；item-0001 复核锁定单独追踪。

section("6. 授权收窄：骑虎造型不再授予该工作室");
await d("withdraw_grant", { id: "grant-shuangyan-2026", effective_at: "2026-06-01T00:00:00+08:00", reason: "师承关系调整，骑虎造型授权收回", replaces_scope: { element_ids: ["elem-face-rabbit"], process_version_ids: ["proc-tuye-v1"], mold_ids: ["mold-old-1908"] }, occurred_at: "2026-05-20T10:00:00+08:00" });
await expectReject("收窄后继续生产", () => d("create_batch", { id: "batch-after", quantity: 5, basis: { kind: "design", id: "design-tuye-contemp" }, occurred_at: "2026-06-02T10:00:00+08:00" }));
await expectReject("收窄后开设引用该设计的新课程", () => d("cite_course", { id: "course-after", course_name: "暑期课", provider_id: "ngo-other", citations: [{ kind: "design", id: "design-tuye-contemp" }], occurred_at: "2026-06-03T10:00:00+08:00" }));

section("7. 定时发现（先看计划，再执行）");
const plan = await svc.planDiscovery("2026-07-01T00:00:00+08:00");
console.log("  待开立处置：");
for (const entry of plan.to_open) console.log(`   - ${entry.affected.kind} ${entry.affected.id}：${entry.affected.requires}`);
console.log(`  既往未闭环处置提醒：${plan.open_reminders.length} 条`);
const run = await svc.runDiscovery({ run_id: "run-20260701", as_of: "2026-07-01T00:00:00+08:00", occurred_at: "2026-07-01T01:00:00+08:00" });
console.log(`  运行 ${run.resumed ? "（恢复）" : ""}开立 ${run.event_ids.length} 个事件`);

section("8. 处置闭环：已售作品/已结束课程保留原依据并发布补正说明");
const soldDisp = plan.to_open.find((x) => x.affected.kind === "item" && x.affected.requires === "correction");
const courseDisp = plan.to_open.find((x) => x.affected.kind === "course");
await expectReject("已售作品缺补正说明不能闭环", () =>
  d("resolve_disposition", { id: soldDisp.id, resolution: "仅下架", occurred_at: "2026-07-02T10:00:00+08:00", resolved_at: "2026-07-02T10:00:00+08:00" }));
await d("approve_statement", { id: "stmt-corr-item-0002", purpose: "correction", disposition_id: soldDisp.id, subject_ref: { kind: "item", id: "item-0002" }, audience: "public", context: "公开补正", title: "关于骑虎兔儿爷师承依据收窄的说明", claim: "您购买的作品生产于授权有效期内，原依据保留；自 2026-06-01 起骑虎造型授权已收回，新款不再沿用该造型。", occurred_at: "2026-07-02T11:00:00+08:00" });
await d("resolve_disposition", { id: soldDisp.id, resolution: "已向消费者发布补正说明", correction_statement_id: "stmt-corr-item-0002", occurred_at: "2026-07-02T12:00:00+08:00", resolved_at: "2026-07-02T12:00:00+08:00" });
await d("approve_statement", { id: "stmt-corr-course-001", purpose: "correction", disposition_id: courseDisp.id, subject_ref: { kind: "item", id: "item-0002" }, audience: "public", context: "课程补正", title: "公益课堂引用依据补正", claim: "4 月课程发生于授权有效期内，原引用依据保留；后续课程停用骑虎造型相关内容。", occurred_at: "2026-07-03T10:00:00+08:00" });
await d("resolve_disposition", { id: courseDisp.id, resolution: "已发布课程补正，后续不再使用", correction_statement_id: "stmt-corr-course-001", occurred_at: "2026-07-03T11:00:00+08:00", resolved_at: "2026-07-03T11:00:00+08:00" });
const unsold = plan.to_open.filter((x) => x.affected.requires === "stop_use");
for (const entry of unsold) {
  // 注：item-0001 处于复核锁定，审计可直接看到；停用处置正常闭环无需补正。
  if (entry.affected.kind === "item" && entry.affected.id === "item-0001") continue;
  await d("resolve_disposition", { id: entry.id, resolution: "停止使用并隔离库存", occurred_at: "2026-07-04T10:00:00+08:00", resolved_at: "2026-07-04T10:00:00+08:00" });
}

section("9. 进程恢复：在只落了 RUN_STARTED 的崩溃副本上续跑同一计划");
const crashStore = new EventStore(join(dir, "events-crash.jsonl"), schema);
for (const e of await store.readAll()) await crashStore.append([e]);
const crashSvc = new LineageService(crashStore);
const crashState = await crashSvc.state();
const firstEvents = domain.runDiscovery(crashState, { run_id: "run-crash", as_of: "2026-07-01T00:00:00+08:00", occurred_at: "2026-07-01T01:00:00+08:00" });
await crashStore.append([firstEvents.events[0]]); // 模拟：计划已持久化，进程随即崩溃
const recovered = await crashSvc.runDiscovery({ run_id: "run-crash", as_of: "2026-07-01T00:00:00+08:00", occurred_at: "2026-07-01T02:00:00+08:00" });
console.log(`  恢复续跑：${recovered.resumed}，补写事件 ${recovered.event_ids.length} 条，未重复开立处置单`);

section("10. 三类最小必要视图");
const state = await svc.state();
const events = await store.readAll();
console.log("--- 消费者视图（item-0002）---");
console.log(JSON.stringify(consumerView(state, { item_id: "item-0002" }, "2026-07-05T00:00:00+08:00"), null, 2));
console.log("--- 授课机构视图（公益课）---");
console.log(JSON.stringify(providerView(state, { course_id: "course-classroom-001" }, "2026-07-05T00:00:00+08:00"), null, 2));
console.log("--- 内部审计视图（item-0002，节选）---");
const audit = auditView(state, events, { item_id: "item-0002" });
console.log(JSON.stringify({
  item: audit.item,
  root: audit.root,
  recognized_by: audit.design.approvals,
  lineage_grants: audit.grants.map((g) => ({ grant_id: g.grant_id, grantor_id: g.grantor_id, withdrawal: g.withdrawal })),
  batch_genealogy: audit.batch_genealogy,
  public_identity_history: audit.public_identity_history.map((s) => ({ statement_id: s.statement_id, context: s.context, purpose: s.purpose })),
  dispositions: audit.dispositions.map((x) => ({ disposition_id: x.disposition_id, requires: x.requires, resolved_at: x.resolved_at })),
  event_count: audit.event_refs.length,
}, null, 2));

await rm(dir, { recursive: true, force: true });
console.log("\n示例完成。");
