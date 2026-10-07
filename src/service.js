import { validateEvent } from "./contracts.js";

export class LineageError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "LineageError";
    this.code = code;
    this.details = details;
  }
}

const REVIEWER_KINDS = ["craft", "folklore"];
const STATEMENT_CHANNELS = ["retail", "exhibition", "course"];
const SCOPE_KEYS = ["elements", "process_versions", "molds"];

function sameMembers(a, b) {
  return a.length === b.length && a.every((item) => b.includes(item));
}

function clone(value) {
  return structuredClone(value);
}

function emptyState() {
  return {
    seq: 0,
    versions: new Map(),
    standards: new Map(),
    designs: new Map(),
    grants: new Map(),
    batches: new Map(),
    works: new Map(),
    statements: new Map(),
    courses: new Map(),
    contributions: [],
  };
}

function applyEvent(state, event) {
  state.seq += 1;
  state.versions.set(`${event.aggregate_type}:${event.aggregate_id}`, event.version);
  const p = event.payload;
  switch (event.event_type) {
    case "STANDARD_RECORDED":
      state.standards.set(event.aggregate_id, {
        standard_id: event.aggregate_id,
        name: p.name,
        designer_id: p.designer_id,
        elements: clone(p.elements ?? []),
        process_versions: clone(p.process_versions ?? []),
        molds: clone(p.molds ?? []),
        signatures: [],
        status: "draft",
      });
      break;
    case "STANDARD_SIGNED": {
      const standard = state.standards.get(event.aggregate_id);
      standard.signatures.push({ reviewer_id: p.reviewer_id, reviewer_kind: p.reviewer_kind, signed_at: event.occurred_at });
      const kinds = new Set(standard.signatures.map((item) => item.reviewer_kind));
      if (kinds.has("craft") && kinds.has("folklore")) standard.status = "approved";
      break;
    }
    case "DESIGN_COMPOSED":
      state.designs.set(event.aggregate_id, {
        design_id: event.aggregate_id,
        designer_id: p.designer_id,
        standard_id: p.standard_id,
        element_refs: clone(p.element_refs),
        process_version: p.process_version,
        mold_refs: clone(p.mold_refs ?? []),
        license_snapshot: clone(p.license_snapshot),
        composed_at: event.occurred_at,
      });
      break;
    case "CONTRIBUTION_RECORDED":
      state.contributions.push({
        subject_type: event.aggregate_type === "work_item" ? "work" : "design",
        subject_id: event.aggregate_id,
        contributor_id: p.contributor_id,
        role: p.role,
        at: event.occurred_at,
      });
      break;
    case "GRANT_ISSUED":
      state.grants.set(event.aggregate_id, {
        grant_id: event.aggregate_id,
        grantor_id: p.grantor_id,
        scope: clone(p.scope),
        valid_until: p.valid_until,
        status: "active",
        history: [{ at: event.occurred_at, type: "issued", scope: clone(p.scope) }],
      });
      break;
    case "GRANT_NARROWED": {
      const grant = state.grants.get(event.aggregate_id);
      grant.scope = clone(p.remaining_scope);
      grant.history.push({ at: p.effective_at, type: "narrowed", scope: clone(p.remaining_scope), reason: p.reason });
      break;
    }
    case "GRANT_WITHDRAWN": {
      const grant = state.grants.get(event.aggregate_id);
      grant.status = "withdrawn";
      grant.history.push({ at: p.effective_at, type: "withdrawn", reason: p.reason });
      break;
    }
    case "GRANT_EXPIRED": {
      const grant = state.grants.get(event.aggregate_id);
      grant.status = "expired";
      grant.history.push({ at: p.expired_at, type: "expired" });
      break;
    }
    case "BATCH_CREATED":
      state.batches.set(event.aggregate_id, {
        batch_id: event.aggregate_id,
        design_id: p.design_id,
        quantity: p.quantity,
        standard_version: p.standard_version,
        process_version: p.process_version,
        status: "open",
        origin: "created",
        parents: [],
      });
      break;
    case "BATCH_SPLIT": {
      const parent = state.batches.get(event.aggregate_id);
      parent.status = "closed";
      for (const child of p.into) {
        state.batches.set(child.batch_id, {
          batch_id: child.batch_id,
          design_id: parent.design_id,
          quantity: child.quantity,
          standard_version: parent.standard_version,
          process_version: parent.process_version,
          status: "open",
          origin: "split",
          parents: [event.aggregate_id],
        });
      }
      break;
    }
    case "BATCH_MERGED": {
      const first = state.batches.get(p.from[0]);
      for (const from of p.from) state.batches.get(from).status = "closed";
      state.batches.set(event.aggregate_id, {
        batch_id: event.aggregate_id,
        design_id: first.design_id,
        quantity: p.quantity,
        standard_version: first.standard_version,
        process_version: first.process_version,
        status: "open",
        origin: "merged",
        parents: clone(p.from),
      });
      break;
    }
    case "BATCH_REWORKED": {
      const parent = state.batches.get(p.from);
      parent.status = "closed";
      state.batches.set(event.aggregate_id, {
        batch_id: event.aggregate_id,
        design_id: parent.design_id,
        quantity: p.quantity,
        standard_version: parent.standard_version,
        process_version: p.process_version,
        status: "open",
        origin: "reworked",
        parents: [p.from],
      });
      break;
    }
    case "WORK_REGISTERED":
      state.works.set(event.aggregate_id, {
        work_id: event.aggregate_id,
        batch_id: p.batch_id,
        fingerprint: p.fingerprint,
        contributor_ids: clone(p.contributor_ids),
        receipt_id: p.receipt_id,
        status: "active",
      });
      break;
    case "WORK_SOLD":
      state.works.get(event.aggregate_id).status = "sold";
      break;
    case "WORK_REVIEW_LOCKED": {
      const work = state.works.get(event.aggregate_id);
      work.status = "locked_for_review";
      work.lock_reason = p.reason;
      break;
    }
    case "STATEMENT_APPROVED":
      state.statements.set(event.aggregate_id, {
        statement_id: event.aggregate_id,
        channel: p.channel,
        subject_type: p.subject_type,
        subject_id: p.subject_id,
        text: p.text,
        basis: clone(p.basis ?? {}),
        status: "active",
        history: [{ at: event.occurred_at, status: "active", text: p.text }],
      });
      break;
    case "STATEMENT_FLAGGED": {
      const statement = state.statements.get(event.aggregate_id);
      statement.status = "needs_correction";
      statement.history.push({ at: event.occurred_at, status: "needs_correction", reason: p.reason });
      break;
    }
    case "STATEMENT_CORRECTED": {
      const statement = state.statements.get(event.aggregate_id);
      statement.text = p.text;
      statement.status = "corrected";
      statement.history.push({ at: event.occurred_at, status: "corrected", text: p.text });
      break;
    }
    case "COURSE_REFERENCED":
      state.courses.set(event.aggregate_id, {
        course_id: event.aggregate_id,
        org_id: p.org_id,
        design_ids: clone(p.design_ids),
        scheduled_at: p.scheduled_at,
        status: "planned",
      });
      break;
    case "COURSE_FINISHED":
      state.courses.get(event.aggregate_id).status = "finished";
      break;
    default:
      break;
  }
}

export async function createLineageService({ store, schema }) {
  const state = emptyState();
  for (const event of await store.readEvents()) applyEvent(state, event);

  async function emit(eventType, aggregateType, aggregateId, payload, now) {
    const event = {
      event_id: `evt-${String(state.seq + 1).padStart(6, "0")}`,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: now ?? new Date().toISOString(),
      version: (state.versions.get(`${aggregateType}:${aggregateId}`) ?? 0) + 1,
      payload,
    };
    const issues = validateEvent(event, schema);
    if (issues.length > 0) throw new LineageError("contract_invalid", "事件未通过领域契约校验", issues);
    await store.appendEvent(event);
    applyEvent(state, event);
    return event;
  }

  function requireEntry(map, id, label) {
    const entry = map.get(id);
    if (!entry) throw new LineageError("not_found", `${label}不存在: ${id}`);
    return entry;
  }

  const requireStandard = (id) => requireEntry(state.standards, id, "制式");
  const requireDesign = (id) => requireEntry(state.designs, id, "衍生设计");
  const requireGrant = (id) => requireEntry(state.grants, id, "师承授权");
  const requireBatch = (id) => requireEntry(state.batches, id, "作品批次");
  const requireWork = (id) => requireEntry(state.works, id, "作品");
  const requireStatement = (id) => requireEntry(state.statements, id, "公开说明");
  const requireCourse = (id) => requireEntry(state.courses, id, "课程");

  function rejectDuplicate(map, id, label) {
    if (map.has(id)) throw new LineageError("duplicate", `${label}已存在: ${id}`);
  }

  function licenseUsable(license, now) {
    const grant = state.grants.get(license.grant_id);
    return Boolean(
      grant
        && grant.status === "active"
        && Date.parse(grant.valid_until) > Date.parse(now)
        && license.elements.every((element) => grant.scope.elements.includes(element)),
    );
  }

  function assertLicensesUsable(design, now, action) {
    for (const license of design.license_snapshot) {
      if (!licenseUsable(license, now)) {
        throw new LineageError("license_unusable", `授权已收窄或失效，${action}停止使用`, {
          design_id: design.design_id,
          grant_id: license.grant_id,
        });
      }
    }
  }

  async function recordStandard({ standard_id, name, designer_id, elements = [], process_versions = [], molds = [], now }) {
    rejectDuplicate(state.standards, standard_id, "制式");
    await emit("STANDARD_RECORDED", "craft_standard", standard_id, { name, designer_id, elements, process_versions, molds }, now);
    return clone(requireStandard(standard_id));
  }

  async function signStandard({ standard_id, reviewer_id, reviewer_kind, now }) {
    const standard = requireStandard(standard_id);
    if (!REVIEWER_KINDS.includes(reviewer_kind)) {
      throw new LineageError("reviewer_kind", "审核者类别必须是技艺（craft）或民俗（folklore）");
    }
    if (reviewer_id === standard.designer_id) {
      throw new LineageError("self_approval", "设计者不能批准自己的作品");
    }
    if (standard.signatures.some((item) => item.reviewer_id === reviewer_id)) {
      throw new LineageError("not_independent", "传统制式认定须由技艺与民俗两类审核者独立签署，同一审核者只能签署一次");
    }
    await emit("STANDARD_SIGNED", "craft_standard", standard_id, { reviewer_id, reviewer_kind }, now);
    return clone(requireStandard(standard_id));
  }

  async function issueGrant({ grant_id, grantor_id, scope, valid_until, now }) {
    rejectDuplicate(state.grants, grant_id, "师承授权");
    await emit("GRANT_ISSUED", "lineage_grant", grant_id, { grantor_id, scope, valid_until }, now);
    return clone(requireGrant(grant_id));
  }

  async function composeDesign({ design_id, designer_id, standard_id, element_refs, process_version, mold_refs = [], grant_ids, now }) {
    rejectDuplicate(state.designs, design_id, "衍生设计");
    const standard = requireStandard(standard_id);
    if (standard.status !== "approved") {
      throw new LineageError("standard_not_approved", "经典元素须来自已完成双签认定的制式");
    }
    const known = new Set(standard.elements.map((element) => element.element_id));
    for (const ref of element_refs) {
      if (!known.has(ref.element_id)) throw new LineageError("unknown_element", `元素不属于该制式: ${ref.element_id}`);
    }
    const at = now ?? new Date().toISOString();
    const license_snapshot = grant_ids.map((grant_id) => {
      const grant = requireGrant(grant_id);
      if (grant.status !== "active" || Date.parse(grant.valid_until) <= Date.parse(at)) {
        throw new LineageError("license_unusable", "组合设计时授权必须处于有效期");
      }
      return {
        grant_id,
        grantor_id: grant.grantor_id,
        elements: element_refs.map((ref) => ref.element_id).filter((element) => grant.scope.elements.includes(element)),
        valid_until: grant.valid_until,
        scope: clone(grant.scope),
        frozen_at: at,
      };
    });
    for (const ref of element_refs) {
      if (!license_snapshot.some((license) => license.elements.includes(ref.element_id))) {
        throw new LineageError("element_not_licensed", `元素缺少有效许可: ${ref.element_id}`);
      }
    }
    await emit("DESIGN_COMPOSED", "derived_design", design_id, {
      designer_id,
      standard_id,
      element_refs,
      process_version,
      mold_refs,
      license_snapshot,
    }, now);
    return clone(requireDesign(design_id));
  }

  async function recordContribution({ subject_id, contributor_id, role, now }) {
    let aggregateType;
    if (state.designs.has(subject_id)) aggregateType = "derived_design";
    else if (state.works.has(subject_id)) aggregateType = "work_item";
    else throw new LineageError("not_found", `贡献对象不存在: ${subject_id}`);
    await emit("CONTRIBUTION_RECORDED", aggregateType, subject_id, { contributor_id, role, subject_id }, now);
  }

  async function createBatch({ batch_id, design_id, quantity, standard_version, now }) {
    rejectDuplicate(state.batches, batch_id, "作品批次");
    const design = requireDesign(design_id);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new LineageError("quantity", "批次数量必须是正整数");
    }
    assertLicensesUsable(design, now ?? new Date().toISOString(), "后续生产");
    await emit("BATCH_CREATED", "work_batch", batch_id, {
      design_id,
      quantity,
      standard_version,
      process_version: design.process_version,
    }, now);
    return clone(requireBatch(batch_id));
  }

  async function splitBatch({ batch_id, into, now }) {
    const parent = requireBatch(batch_id);
    if (parent.status !== "open") throw new LineageError("batch_closed", "批次已关闭，不能拆分");
    for (const child of into) rejectDuplicate(state.batches, child.batch_id, "作品批次");
    const total = into.reduce((sum, child) => sum + child.quantity, 0);
    if (total !== parent.quantity) {
      throw new LineageError("quantity_mismatch", "批次拆分必须保持数量守恒");
    }
    await emit("BATCH_SPLIT", "work_batch", batch_id, { into }, now);
  }

  async function mergeBatches({ from, batch_id, now }) {
    rejectDuplicate(state.batches, batch_id, "作品批次");
    const parents = from.map((id) => requireBatch(id));
    for (const parent of parents) {
      if (parent.status !== "open") throw new LineageError("batch_closed", `批次已关闭，不能合并: ${parent.batch_id}`);
    }
    if (!parents.every((parent) => parent.design_id === parents[0].design_id)) {
      throw new LineageError("design_mismatch", "只有同一设计的批次才能合并");
    }
    const quantity = parents.reduce((sum, parent) => sum + parent.quantity, 0);
    await emit("BATCH_MERGED", "work_batch", batch_id, { from, quantity }, now);
    return clone(requireBatch(batch_id));
  }

  async function reworkBatch({ batch_id, into_batch_id, process_version, note, now }) {
    const parent = requireBatch(batch_id);
    rejectDuplicate(state.batches, into_batch_id, "作品批次");
    if (parent.status !== "open") throw new LineageError("batch_closed", "批次已关闭，不能返工");
    await emit("BATCH_REWORKED", "work_batch", into_batch_id, {
      from: batch_id,
      quantity: parent.quantity,
      process_version,
      note,
    }, now);
    return clone(requireBatch(into_batch_id));
  }

  async function registerWork({ work_id, batch_id, fingerprint, contributor_ids, now }) {
    const batch = requireBatch(batch_id);
    const existing = state.works.get(work_id);
    if (existing) {
      const identical = existing.batch_id === batch_id
        && existing.fingerprint === fingerprint
        && sameMembers(existing.contributor_ids, contributor_ids);
      if (identical) {
        return { work_id, receipt_id: existing.receipt_id, reused: true, status: existing.status };
      }
      await emit("WORK_REVIEW_LOCKED", "work_item", work_id, { work_id, reason: "指纹或贡献人变化，锁定复核" }, now);
      return { work_id, receipt_id: existing.receipt_id, reused: false, status: "locked_for_review" };
    }
    if (batch.status !== "open") throw new LineageError("batch_closed", "批次已关闭，不能登记作品");
    const receipt_id = `rcpt-${work_id}`;
    await emit("WORK_REGISTERED", "work_item", work_id, { work_id, batch_id, fingerprint, contributor_ids, receipt_id }, now);
    return { work_id, receipt_id, reused: false, status: "active" };
  }

  async function markWorkSold({ work_id, now }) {
    const work = requireWork(work_id);
    if (work.status !== "active") throw new LineageError("work_not_active", "只有登记在册的作品才能标记售出");
    await emit("WORK_SOLD", "work_item", work_id, {}, now);
  }

  async function approveStatement({ statement_id, channel, subject_type, subject_id, text, basis, now }) {
    rejectDuplicate(state.statements, statement_id, "公开说明");
    if (!STATEMENT_CHANNELS.includes(channel)) {
      throw new LineageError("channel", "公开说明渠道必须是门店（retail）、展陈（exhibition）或课程（course）");
    }
    if (subject_type === "work") requireWork(subject_id);
    else if (subject_type === "design") requireDesign(subject_id);
    else if (subject_type === "course") requireCourse(subject_id);
    else throw new LineageError("subject_type", `未知的说明对象类型: ${subject_type}`);
    await emit("STATEMENT_APPROVED", "public_statement", statement_id, { channel, subject_type, subject_id, text, basis }, now);
    return clone(requireStatement(statement_id));
  }

  async function correctStatement({ statement_id, text, now }) {
    const statement = requireStatement(statement_id);
    if (statement.status !== "needs_correction") {
      throw new LineageError("no_correction_needed", "只有需要补正的公开说明才能补正");
    }
    await emit("STATEMENT_CORRECTED", "public_statement", statement_id, { text }, now);
    return clone(requireStatement(statement_id));
  }

  async function referenceCourse({ course_id, org_id, design_ids, scheduled_at, now }) {
    rejectDuplicate(state.courses, course_id, "课程");
    const at = now ?? new Date().toISOString();
    for (const designId of design_ids) assertLicensesUsable(requireDesign(designId), at, "新课程");
    await emit("COURSE_REFERENCED", "course", course_id, { org_id, design_ids, scheduled_at }, now);
    return clone(requireCourse(course_id));
  }

  async function finishCourse({ course_id, now }) {
    const course = requireCourse(course_id);
    if (course.status !== "planned") throw new LineageError("course_not_planned", "只有进行中的课程才能结课");
    await emit("COURSE_FINISHED", "course", course_id, {}, now);
  }

  // 授权收窄或终止后：后续生产与新课程在创建时被拒绝；已售作品与已结束活动的
  // 公开说明保留原依据；其余引用该授权的公开说明生成需要补正的标记。
  async function flagStatementsForGrant(grant_id, reason, now) {
    const flagged = [];
    const preserved = [];
    for (const statement of state.statements.values()) {
      if (statement.status !== "active" || !(statement.basis.grant_ids ?? []).includes(grant_id)) continue;
      const subject = statement.subject_type === "work"
        ? state.works.get(statement.subject_id)
        : statement.subject_type === "course"
          ? state.courses.get(statement.subject_id)
          : null;
      if (subject?.status === "sold" || subject?.status === "finished") {
        preserved.push(statement.statement_id);
        continue;
      }
      await emit("STATEMENT_FLAGGED", "public_statement", statement.statement_id, { reason, grant_id }, now);
      flagged.push(statement.statement_id);
    }
    return { flagged, preserved };
  }

  async function narrowGrant({ grant_id, remaining_scope, effective_at, reason, now }) {
    const grant = requireGrant(grant_id);
    if (grant.status !== "active") throw new LineageError("grant_inactive", "授权已不可用，不能收窄");
    for (const key of SCOPE_KEYS) {
      const current = grant.scope[key] ?? [];
      const remaining = remaining_scope[key] ?? [];
      if (!remaining.every((item) => current.includes(item))) {
        throw new LineageError("not_narrowing", "授权收窄只能在原范围内缩小");
      }
    }
    await emit("GRANT_NARROWED", "lineage_grant", grant_id, { effective_at, remaining_scope, reason }, now);
    return flagStatementsForGrant(grant_id, `授权收窄：${reason}`, now ?? effective_at);
  }

  async function withdrawGrant({ grant_id, effective_at, reason, now }) {
    const grant = requireGrant(grant_id);
    if (grant.status !== "active") throw new LineageError("grant_inactive", "授权已不可用，不能撤回");
    await emit("GRANT_WITHDRAWN", "lineage_grant", grant_id, { effective_at, reason }, now);
    return flagStatementsForGrant(grant_id, `授权撤回：${reason}`, now ?? effective_at);
  }

  // 定期任务：先落库计划再执行，进程恢复后按计划时间继续原计划。
  async function planSweep({ sweep_id, planned_at }) {
    const sweeps = await store.readSweeps();
    if (sweeps.some((sweep) => sweep.sweep_id === sweep_id)) {
      throw new LineageError("duplicate", `定期任务已存在: ${sweep_id}`);
    }
    const record = { sweep_id, planned_at, status: "planned", findings: null };
    await store.saveSweep(record);
    return clone(record);
  }

  async function runSweep(sweep_id) {
    const record = (await store.readSweeps()).find((sweep) => sweep.sweep_id === sweep_id);
    if (!record) throw new LineageError("not_found", `定期任务不存在: ${sweep_id}`);
    if (record.status === "done") return clone(record);
    const now = record.planned_at;
    const findings = { expired_grants: [], flagged_statements: [], unfinished_dispositions: [] };
    for (const grant of [...state.grants.values()]) {
      if (grant.status === "active" && Date.parse(grant.valid_until) <= Date.parse(now)) {
        await emit("GRANT_EXPIRED", "lineage_grant", grant.grant_id, { expired_at: now }, now);
        findings.expired_grants.push(grant.grant_id);
        const { flagged } = await flagStatementsForGrant(grant.grant_id, "授权到期，公开说明需要补正", now);
        findings.flagged_statements.push(...flagged);
      }
    }
    for (const statement of state.statements.values()) {
      if (statement.status === "needs_correction") findings.unfinished_dispositions.push(statement.statement_id);
    }
    record.status = "done";
    record.finished_at = now;
    record.findings = findings;
    await store.saveSweep(record);
    return clone(record);
  }

  async function resumeSweeps() {
    const resumed = [];
    for (const sweep of await store.readSweeps()) {
      if (sweep.status !== "done") resumed.push(await runSweep(sweep.sweep_id));
    }
    return resumed;
  }

  function latestStatement(filter) {
    let found = null;
    for (const statement of state.statements.values()) {
      if (filter(statement)) found = statement;
    }
    return found;
  }

  // 消费者视图：只保留公开身份、造型来源、认定情况与依据时效。
  function consumerView(work_id, now = new Date().toISOString()) {
    const work = requireWork(work_id);
    const batch = requireBatch(work.batch_id);
    const design = requireDesign(batch.design_id);
    const standard = requireStandard(design.standard_id);
    const statement = latestStatement((item) => item.subject_id === work_id && item.channel !== "course");
    const basisValid = design.license_snapshot.every((license) => licenseUsable(license, now));
    return {
      work_id,
      public_identity: statement?.text ?? null,
      statement_status: statement?.status ?? "unpublished",
      origin: {
        standard_name: standard.name,
        elements: design.element_refs.map((ref) => standard.elements.find((element) => element.element_id === ref.element_id)?.name ?? ref.element_id),
        process_version: batch.process_version,
        molds: design.mold_refs.map((id) => standard.molds.find((mold) => mold.mold_id === id)?.source ?? id),
      },
      recognition: standard.status === "approved" ? "技艺与民俗双签认定" : "认定未完成",
      basis_note: work.status === "sold" ? "已售作品保留原依据" : basisValid ? "依据现行有效授权" : "授权已变化，公开说明待补正",
    };
  }

  // 授课机构视图：课程计划、引用设计、师承来源与当前能否继续授课。
  function institutionView(course_id, now = new Date().toISOString()) {
    const course = requireCourse(course_id);
    const designs = course.design_ids.map((id) => requireDesign(id));
    return {
      course_id,
      org_id: course.org_id,
      status: course.status,
      scheduled_at: course.scheduled_at,
      designs: designs.map((design) => ({
        design_id: design.design_id,
        elements: design.element_refs.map((ref) => ref.element_id),
        process_version: design.process_version,
      })),
      lineage: designs.flatMap((design) => design.license_snapshot.map((license) => ({
        design_id: design.design_id,
        grantor_id: license.grantor_id,
        valid_until: license.valid_until,
        current_status: state.grants.get(license.grant_id)?.status ?? "unknown",
      }))),
      teaching_allowed: course.status !== "planned"
        || designs.every((design) => design.license_snapshot.every((license) => licenseUsable(license, now))),
    };
  }

  // 内部审计：从任一作品回看批次谱系、工序、师承、贡献与历次公开身份。
  function auditTrace(work_id) {
    const work = requireWork(work_id);
    const batch = requireBatch(work.batch_id);
    const ancestors = [];
    const visit = (id) => {
      for (const parentId of state.batches.get(id)?.parents ?? []) {
        const parent = state.batches.get(parentId);
        if (parent && !ancestors.some((item) => item.batch_id === parent.batch_id)) {
          ancestors.push(clone(parent));
          visit(parent.batch_id);
        }
      }
    };
    visit(batch.batch_id);
    const design = requireDesign(batch.design_id);
    const standard = requireStandard(design.standard_id);
    return {
      work: clone(work),
      batch: clone(batch),
      batch_ancestors: ancestors,
      process: { current: batch.process_version, standard_versions: clone(standard.process_versions) },
      design: clone(design),
      standard: clone(standard),
      lineage_grants: design.license_snapshot.map((license) => clone(requireGrant(license.grant_id))),
      contributions: state.contributions
        .filter((item) => item.subject_id === work_id || item.subject_id === design.design_id)
        .map(clone),
      public_identities: [...state.statements.values()].filter((item) => item.subject_id === work_id).map(clone),
    };
  }

  return {
    recordStandard,
    signStandard,
    issueGrant,
    composeDesign,
    recordContribution,
    createBatch,
    splitBatch,
    mergeBatches,
    reworkBatch,
    registerWork,
    markWorkSold,
    approveStatement,
    correctStatement,
    referenceCourse,
    finishCourse,
    narrowGrant,
    withdrawGrant,
    planSweep,
    runSweep,
    resumeSweeps,
    listSweeps: () => store.readSweeps(),
    consumerView,
    institutionView,
    auditTrace,
    getStandard: (id) => clone(requireStandard(id)),
    getDesign: (id) => clone(requireDesign(id)),
    getGrant: (id) => clone(requireGrant(id)),
    getBatch: (id) => clone(requireBatch(id)),
    getWork: (id) => clone(requireWork(id)),
    getStatement: (id) => clone(requireStatement(id)),
    getCourse: (id) => clone(requireCourse(id)),
  };
}
