// 纯函数领域层：事件 -> 状态归算（reducer），命令 -> 事件（decide）。
// 不做任何 IO；时间一律由调用方在命令输入中给出（必须带时区）。

export class DomainError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.field = field;
  }
}

const REVIEW_KINDS = ["craft", "folklore"];

// ---------- 时间与集合工具 ----------

export function toTime(value) {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new DomainError("timezone_required", "时间必须是带时区的 ISO 字符串", "occurred_at");
  return ms;
}

function sameSet(a, b) {
  return a.length === b.length && [...a].every((x) => b.includes(x));
}

function scopeRefs(scope) {
  return {
    element_ids: scope?.element_ids ?? [],
    process_version_ids: scope?.process_version_ids ?? [],
    mold_ids: scope?.mold_ids ?? [],
  };
}

// 授权在某时刻的实际范围：到达收窄生效点后替换为更窄范围；到期后为空。
export function effectiveScopeAt(grant, atMs) {
  if (!grant) return null;
  if (atMs < toTime(grant.valid_from) || atMs > toTime(grant.valid_until)) return null;
  if (grant.withdrawal && atMs >= toTime(grant.withdrawal.effective_at)) {
    return grant.withdrawal.replaces_scope ?? {};
  }
  return grant.scope ?? {};
}

function covered(refs, grants, atMs) {
  const missing = [];
  for (const [kind, ids] of Object.entries(refs)) {
    for (const id of ids) {
      const ok = grants.some((g) => {
        const scope = effectiveScopeAt(g, atMs);
        if (!scope) return false;
        return scopeRefs(scope)[kind]?.includes(id);
      });
      if (!ok) missing.push({ kind, id });
    }
  }
  return missing;
}

function grantsFor(state, ids) {
  return ids.map((id) => state.grants.get(id)).filter(Boolean);
}

// ---------- 初始状态与归算 ----------

export function initialState() {
  return {
    seq: 0,
    aggVersions: new Map(),
    standards: new Map(),
    elements: new Map(),
    processes: new Map(),
    molds: new Map(),
    grants: new Map(),
    designs: new Map(),
    batches: new Map(),
    items: new Map(),
    itemNoIndex: new Map(),
    statements: new Map(),
    statementsBySubject: new Map(),
    courses: new Map(),
    dispositions: new Map(),
    runs: new Map(),
  };
}

function bump(state, aggregateType, aggregateId) {
  const key = `${aggregateType}:${aggregateId}`;
  const v = (state.aggVersions.get(key) ?? 0) + 1;
  state.aggVersions.set(key, v);
  return v;
}

export function applyEvent(state, event) {
  const { event_type: type, aggregate_id: id, payload: p, occurred_at: at } = event;
  state.seq += 1;
  const version = bump(state, event.aggregate_type, id);
  if (version !== event.version) {
    throw new DomainError("version_conflict", `聚合 ${id} 版本 ${event.version} 与期望 ${version} 不一致`, "version");
  }
  switch (type) {
    case "STANDARD_RECORDED": {
      const previous = state.standards.get(id);
      state.standards.set(id, {
        id,
        name: p.name,
        tradition: p.tradition,
        version: p.version,
        element_ids: p.element_ids,
        process_version_ids: p.process_version_ids,
        // 制式修订（新版本）后旧签署不再适用于新版本，需要重新双签。
        signatures: previous && previous.version === p.version ? previous.signatures : [],
        approved_version: previous && previous.version === p.version ? previous.approved_version : null,
        recorded_at: at,
      });
      break;
    }
    case "STANDARD_SIGNED": {
      const standard = state.standards.get(id);
      if (!standard) throw new DomainError("not_found", "制式不存在", "standard_id");
      standard.signatures.push({
        standard_version: p.standard_version,
        reviewer_id: p.reviewer_id,
        reviewer_kind: p.reviewer_kind,
        signed_at: p.signed_at ?? at,
      });
      const kinds = new Set(standard.signatures.map((s) => s.reviewer_kind));
      if (REVIEW_KINDS.every((k) => kinds.has(k))) standard.approved_version = p.standard_version;
      break;
    }
    case "ELEMENT_REGISTERED":
      state.elements.set(id, { id, name: p.name, canonical_spec: p.canonical_spec, registered_at: at });
      break;
    case "PROCESS_VERSION_RECORDED":
      state.processes.set(id, {
        id,
        standard_id: p.standard_id,
        version: p.version,
        steps: p.steps,
        recorded_at: at,
      });
      break;
    case "MOLD_RECORDED":
      state.molds.set(id, { id, origin: p.origin, acquired_at: p.acquired_at, recorded_at: at });
      break;
    case "GRANT_ISSUED":
      state.grants.set(id, {
        id,
        grantor_id: p.grantor_id,
        grantee_id: p.grantee_id,
        scope: p.scope,
        valid_from: p.valid_from,
        valid_until: p.valid_until,
        withdrawal: null,
        issued_at: at,
      });
      break;
    case "GRANT_WITHDRAWN": {
      const grant = state.grants.get(id);
      if (!grant) throw new DomainError("not_found", "师承授权不存在", "grant_id");
      grant.withdrawal = { effective_at: p.effective_at, reason: p.reason, replaces_scope: p.replaces_scope ?? {} };
      break;
    }
    case "DESIGN_FROZEN":
      state.designs.set(id, {
        id,
        designer_id: p.designer_id,
        element_refs: p.element_refs,
        process_refs: p.process_refs,
        mold_refs: p.mold_refs,
        grant_snapshot: p.grant_snapshot,
        content_fingerprint: p.content_fingerprint,
        approvals: [],
        approved: false,
        frozen_at: at,
      });
      break;
    case "DESIGN_APPROVED": {
      const design = state.designs.get(id);
      if (!design) throw new DomainError("not_found", "设计不存在", "design_id");
      design.approvals = p.approvals;
      design.approved = true;
      design.approved_at = at;
      break;
    }
    case "BATCH_CREATED":
      state.batches.set(id, {
        id,
        quantity: p.quantity,
        basis: p.basis,
        status: "active",
        created_at: at,
      });
      break;
    case "BATCH_SPLIT": {
      const source = state.batches.get(id);
      if (!source) throw new DomainError("not_found", "拆分来源批次不存在", "source_batch_id");
      const total = p.splits.reduce((n, s) => n + s.quantity, 0);
      if (total !== source.quantity || source.status !== "active") {
        throw new DomainError("quantity_not_conserved", `批次拆分数量不守恒：${source.quantity} != ${total}`, "splits");
      }
      source.status = "split";
      for (const s of p.splits) {
        if (state.batches.has(s.batch_id)) throw new DomainError("batch_exists", "目标批次已存在", "splits");
        state.batches.set(s.batch_id, {
          id: s.batch_id,
          quantity: s.quantity,
          basis: { kind: "batch_split", parents: [id] },
          status: "active",
          created_at: at,
        });
      }
      break;
    }
    case "BATCH_MERGED": {
      const sources = p.source_batch_ids.map((sid) => state.batches.get(sid));
      if (sources.some((b) => !b)) throw new DomainError("not_found", "合并来源批次不存在", "source_batch_ids");
      const total = sources.reduce((n, b) => n + b.quantity, 0);
      if (total !== p.quantity) {
        throw new DomainError("quantity_not_conserved", `批次合并数量不守恒：${total} != ${p.quantity}`, "quantity");
      }
      if (sources.some((b) => b.status !== "active")) {
        throw new DomainError("quantity_not_conserved", "只能合并且仍在活动的批次", "source_batch_ids");
      }
      for (const b of sources) b.status = "merged";
      state.batches.set(id, {
        id,
        quantity: p.quantity,
        basis: { kind: "batch_merge", parents: p.source_batch_ids },
        status: "active",
        created_at: at,
      });
      break;
    }
    case "BATCH_REWORKED": {
      const source = state.batches.get(p.source_batch_id);
      if (!source) throw new DomainError("not_found", "返工来源批次不存在", "source_batch_id");
      if (source.status !== "active" || source.quantity !== p.quantity) {
        throw new DomainError("quantity_not_conserved", "返工必须整批进行且数量守恒", "quantity");
      }
      source.status = "reworked";
      state.batches.set(id, {
        id,
        quantity: p.quantity,
        basis: { kind: "batch_rework", parents: [source.id], reason: p.reason },
        status: "active",
        created_at: at,
      });
      break;
    }
    case "ITEM_REGISTERED": {
      const batch = state.batches.get(p.batch_id);
      if (!batch) throw new DomainError("not_found", "作品所属批次不存在", "batch_id");
      const item = {
        id,
        batch_id: p.batch_id,
        item_no: p.item_no,
        content_fingerprint: p.content_fingerprint,
        contributor_ids: p.contributor_ids,
        basis: p.basis,
        locks: [],
        sold_at: null,
        registered_at: at,
      };
      state.items.set(id, item);
      state.itemNoIndex.set(p.item_no, id);
      break;
    }
    case "ITEM_REVIEW_LOCKED": {
      const item = state.items.get(id);
      if (!item) throw new DomainError("not_found", "作品不存在", "item_id");
      item.locks.push({ reason: p.reason, detail: p.detail ?? null, locked_at: at });
      break;
    }
    case "ITEM_SOLD": {
      const item = state.items.get(id);
      if (!item) throw new DomainError("not_found", "作品不存在", "item_id");
      item.sold_at = p.sold_at;
      break;
    }
    case "STATEMENT_APPROVED": {
      const stmt = {
        id,
        subject_ref: p.subject_ref,
        audience: p.audience,
        context: p.context,
        title: p.title,
        claim: p.claim,
        basis: p.basis,
        purpose: p.purpose ?? "public",
        disposition_id: p.disposition_id ?? null,
        approved_at: at,
      };
      state.statements.set(id, stmt);
      const key = `${p.subject_ref.kind}:${p.subject_ref.id}`;
      if (!state.statementsBySubject.has(key)) state.statementsBySubject.set(key, []);
      state.statementsBySubject.get(key).push(stmt);
      break;
    }
    case "COURSE_CITED":
      state.courses.set(id, {
        id,
        course_name: p.course_name,
        provider_id: p.provider_id,
        citations: p.citations,
        cited_at: at,
        ended_at: null,
      });
      break;
    case "COURSE_ENDED": {
      const course = state.courses.get(id);
      if (!course) throw new DomainError("not_found", "课程不存在", "course_id");
      course.ended_at = p.ended_at;
      break;
    }
    case "DISPOSITION_OPENED":
      state.dispositions.set(id, {
        id,
        trigger: p.trigger,
        grant_id: p.grant_id,
        scope_after: p.scope_after,
        affected: p.affected,
        run_id: p.run_id ?? null,
        opened_at: at,
        resolved_at: null,
        resolution: null,
        correction_statement_id: null,
      });
      break;
    case "DISPOSITION_RESOLVED": {
      const d = state.dispositions.get(id);
      if (!d) throw new DomainError("not_found", "处置单不存在", "disposition_id");
      d.resolved_at = p.resolved_at;
      d.resolution = p.resolution;
      d.correction_statement_id = p.correction_statement_id ?? null;
      break;
    }
    case "RUN_STARTED":
      state.runs.set(id, { id, plan: p.plan, steps: [], finished: false, summary: null, started_at: at });
      break;
    case "RUN_ADVANCED": {
      const run = state.runs.get(id);
      if (!run) throw new DomainError("not_found", "发现任务不存在", "run_id");
      run.steps.push({ step: p.step, disposition_ids: p.disposition_ids, at });
      break;
    }
    case "RUN_FINISHED": {
      const run = state.runs.get(id);
      if (!run) throw new DomainError("not_found", "发现任务不存在", "run_id");
      run.finished = true;
      run.summary = p.summary;
      run.finished_at = at;
      break;
    }
    default:
      throw new DomainError("unknown_event", `未知事件类型 ${type}`, "event_type");
  }
  return state;
}

export function reduce(events) {
  const state = initialState();
  for (const e of events) applyEvent(state, e);
  return state;
}

// ---------- 命令：decide(state, input) -> events ----------

function envelope(state, eventType, aggregateType, aggregateId, occurredAt, payload) {
  const key = `${aggregateType}:${aggregateId}`;
  return {
    event_id: `${key}:v${(state.aggVersions.get(key) ?? 0) + 1}`,
    event_type: eventType,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    occurred_at: occurredAt,
    version: (state.aggVersions.get(key) ?? 0) + 1,
    payload,
  };
}

// 一次 decide 产生同一聚合多个事件时（如扫描运行），用 recorder 保证版本连续。
function recorder(state) {
  const delta = new Map();
  const events = [];
  function emit(eventType, aggregateType, aggregateId, occurredAt, payload) {
    const key = `${aggregateType}:${aggregateId}`;
    const d = (delta.get(key) ?? 0) + 1;
    delta.set(key, d);
    const version = (state.aggVersions.get(key) ?? 0) + d;
    const e = {
      event_id: `${key}:v${version}`,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: occurredAt,
      version,
      payload,
    };
    events.push(e);
    return e;
  }
  return { emit, events };
}

function requireExist(state, refs) {
  for (const { kind, id } of refs) {
    const table = {
      element: state.elements,
      process: state.processes,
      mold: state.molds,
      standard: state.standards,
      grant: state.grants,
      design: state.designs,
      batch: state.batches,
      item: state.items,
      statement: state.statements,
      course: state.courses,
      disposition: state.dispositions,
    }[kind];
    if (!table?.get(id)) throw new DomainError("not_found", `${kind} ${id} 不存在`, `${kind}_id`);
  }
}

export function registerElement(state, input) {
  if (state.elements.has(input.id)) throw new DomainError("already_exists", "经典元素已登记", "id");
  return [
    envelope(state, "ELEMENT_REGISTERED", "classic_element", input.id, input.occurred_at, {
      name: input.name,
      canonical_spec: input.canonical_spec,
    }),
  ];
}

export function recordProcessVersion(state, input) {
  if (state.processes.has(input.id)) throw new DomainError("already_exists", "工序版本已登记", "id");
  requireExist(state, [{ kind: "standard", id: input.standard_id }]);
  return [
    envelope(state, "PROCESS_VERSION_RECORDED", "process_version", input.id, input.occurred_at, {
      standard_id: input.standard_id,
      version: input.version,
      steps: input.steps,
    }),
  ];
}

export function recordMold(state, input) {
  if (state.molds.has(input.id)) throw new DomainError("already_exists", "模具已登记", "id");
  return [
    envelope(state, "MOLD_RECORDED", "mold_source", input.id, input.occurred_at, {
      origin: input.origin,
      acquired_at: input.acquired_at,
    }),
  ];
}

export function recordStandard(state, input) {
  const existing = state.standards.get(input.id);
  if (existing && existing.version >= input.version) {
    throw new DomainError("version_conflict", "制式版本必须高于既有版本", "version");
  }
  for (const eid of input.element_ids) requireExist(state, [{ kind: "element", id: eid }]);
  for (const pid of input.process_version_ids) requireExist(state, [{ kind: "process", id: pid }]);
  return [
    envelope(state, "STANDARD_RECORDED", "craft_standard", input.id, input.occurred_at, {
      name: input.name,
      tradition: input.tradition,
      version: input.version,
      element_ids: input.element_ids,
      process_version_ids: input.process_version_ids,
    }),
  ];
}

export function signStandard(state, input) {
  const standard = state.standards.get(input.id);
  if (!standard) throw new DomainError("not_found", "制式不存在", "id");
  if (input.standard_version !== standard.version) {
    throw new DomainError("version_mismatch", "只能签署当前制式版本", "standard_version");
  }
  if (!REVIEW_KINDS.includes(input.reviewer_kind)) {
    throw new DomainError("reviewer_kind_invalid", "审核者类别必须是 craft 或 folklore", "reviewer_kind");
  }
  const existing = standard.signatures.find((s) => s.reviewer_kind === input.reviewer_kind);
  if (existing && existing.reviewer_id !== input.reviewer_id) {
    throw new DomainError("independent_signature_required", `该制式版本已有另一 ${input.reviewer_kind} 审核者签署`, "reviewer_id");
  }
  if (existing) return []; // 同人重签：幂等无新事件
  return [
    envelope(state, "STANDARD_SIGNED", "craft_standard", input.id, input.occurred_at, {
      standard_version: input.standard_version,
      reviewer_id: input.reviewer_id,
      reviewer_kind: input.reviewer_kind,
    }),
  ];
}

export function issueGrant(state, input) {
  if (state.grants.has(input.id)) throw new DomainError("already_exists", "授权已存在", "id");
  const at = toTime(input.valid_from);
  if (toTime(input.valid_until) <= at) throw new DomainError("invalid_range", "授权截止必须晚于生效", "valid_until");
  return [
    envelope(state, "GRANT_ISSUED", "lineage_grant", input.id, input.occurred_at, {
      grantor_id: input.grantor_id,
      grantee_id: input.grantee_id,
      scope: input.scope,
      valid_from: input.valid_from,
      valid_until: input.valid_until,
    }),
  ];
}

export function withdrawGrant(state, input) {
  const grant = state.grants.get(input.id);
  if (!grant) throw new DomainError("not_found", "师承授权不存在", "id");
  if (grant.withdrawal) throw new DomainError("already_withdrawn", "授权已收窄，不能重复收窄", "id");
  return [
    envelope(state, "GRANT_WITHDRAWN", "lineage_grant", input.id, input.occurred_at, {
      effective_at: input.effective_at,
      reason: input.reason,
      replaces_scope: input.replaces_scope ?? {},
    }),
  ];
}

function designRefs(input) {
  return {
    element_ids: input.element_refs,
    process_version_ids: input.process_refs,
    mold_ids: input.mold_refs,
  };
}

export function freezeDesign(state, input) {
  if (state.designs.has(input.id)) throw new DomainError("already_exists", "设计已冻结", "id");
  const at = toTime(input.occurred_at);
  const refs = designRefs(input);
  for (const id of refs.element_ids) requireExist(state, [{ kind: "element", id }]);
  for (const id of refs.process_version_ids) requireExist(state, [{ kind: "process", id }]);
  for (const id of refs.mold_ids) requireExist(state, [{ kind: "mold", id }]);
  // 冻结时：每一项来源都必须有当时有效、且授予设计者的许可；快照从此固定。
  const live = [...state.grants.values()].filter((g) => g.grantee_id === input.designer_id);
  const missing = covered(refs, live, at);
  if (missing.length) {
    throw new DomainError(
      "unlicensed_source",
      `来源在冻结时缺少有效师承许可：${missing.map((m) => m.id).join(", ")}`,
      "grant_snapshot",
    );
  }
  const snapshot = live
    .filter((g) => effectiveScopeAt(g, at))
    .map((g) => ({
      grant_id: g.id,
      grantor_id: g.grantor_id,
      grantee_id: g.grantee_id,
      scope: effectiveScopeAt(g, at),
      valid_from: g.valid_from,
      valid_until: g.valid_until,
      withdrawn: g.withdrawal !== null,
    }));
  return [
    envelope(state, "DESIGN_FROZEN", "design", input.id, input.occurred_at, {
      designer_id: input.designer_id,
      element_refs: input.element_refs,
      process_refs: input.process_refs,
      mold_refs: input.mold_refs,
      grant_snapshot: snapshot,
      content_fingerprint: input.content_fingerprint,
    }),
  ];
}

export function approveDesign(state, input) {
  const design = state.designs.get(input.id);
  if (!design) throw new DomainError("not_found", "设计不存在", "id");
  if (design.approved) throw new DomainError("already_approved", "设计已批准", "id");
  const approvals = input.approvals ?? [];
  const kinds = new Set(approvals.map((a) => a.reviewer_kind));
  if (approvals.length !== 2 || !REVIEW_KINDS.every((k) => kinds.has(k))) {
    throw new DomainError("two_independent_approvals_required", "新设计必须由技艺、民俗两类审核者各一人批准", "approvals");
  }
  const ids = approvals.map((a) => a.reviewer_id);
  if (new Set(ids).size !== 2) throw new DomainError("two_independent_approvals_required", "两类签署必须是不同审核者", "approvals");
  if (ids.includes(design.designer_id)) {
    throw new DomainError("designer_cannot_approve_own_work", "设计者不能批准自己的作品", "approvals");
  }
  return [
    envelope(state, "DESIGN_APPROVED", "design", input.id, input.occurred_at, {
      approvals: approvals.map((a) => ({
        reviewer_id: a.reviewer_id,
        reviewer_kind: a.reviewer_kind,
        signed_at: a.signed_at ?? input.occurred_at,
      })),
    }),
  ];
}

// 生产/引用时的许可复核：冻结的快照许可在当下仍覆盖全部来源。
export function designUsableAt(state, design, atMs) {
  if (!design || !design.approved) return { usable: false, reason: "design_not_approved" };
  const grants = grantsFor(state, design.grant_snapshot.map((s) => s.grant_id));
  const refs = {
    element_ids: design.element_refs,
    process_version_ids: design.process_refs,
    mold_ids: design.mold_refs,
  };
  const missing = covered(refs, grants, atMs);
  return missing.length ? { usable: false, reason: "grant_scope_lost", missing } : { usable: true };
}

export function createBatch(state, input) {
  const at = toTime(input.occurred_at);
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new DomainError("positive_integer", "批次数量必须为正整数", "quantity");
  }
  if (state.batches.has(input.id)) throw new DomainError("already_exists", "批次已存在", "id");
  let basis;
  if (input.basis.kind === "design") {
    const design = state.designs.get(input.basis.id);
    if (!design) throw new DomainError("not_found", "批次依据的设计不存在", "basis");
    const check = designUsableAt(state, design, at);
    if (!check.usable) throw new DomainError("production_halted", `授权收窄后不得继续生产：${check.reason}`, "basis");
    basis = { kind: "design", design_id: design.id, fingerprint: design.content_fingerprint };
  } else if (input.basis.kind === "standard") {
    const standard = state.standards.get(input.basis.id);
    if (!standard || !standard.approved_version) {
      throw new DomainError("standard_not_recognized", "制式未经两类审核者共同认定", "basis");
    }
    basis = { kind: "standard", standard_id: standard.id, standard_version: standard.approved_version };
  } else {
    throw new DomainError("invalid_basis", "批次只能基于已认定制式或已批准设计", "basis");
  }
  return [
    envelope(state, "BATCH_CREATED", "work_batch", input.id, input.occurred_at, {
      quantity: input.quantity,
      basis,
    }),
  ];
}

export function splitBatch(state, input) {
  const source = state.batches.get(input.source_batch_id);
  if (!source) throw new DomainError("not_found", "拆分来源批次不存在", "source_batch_id");
  if (source.status !== "active") throw new DomainError("quantity_not_conserved", "来源批次已不在活动状态", "source_batch_id");
  if (!input.splits?.length) throw new DomainError("splits_required", "拆分至少产生一个批次", "splits");
  const total = input.splits.reduce((n, s) => n + s.quantity, 0);
  if (total !== source.quantity || input.splits.some((s) => s.quantity <= 0)) {
    throw new DomainError("quantity_not_conserved", `拆分数量不守恒：${source.quantity} != ${total}`, "splits");
  }
  // 事件落在来源批次聚合上，目标批次在归算时物化。
  return [
    envelope(state, "BATCH_SPLIT", "work_batch", input.source_batch_id, input.occurred_at, {
      source_batch_id: input.source_batch_id,
      splits: input.splits,
    }),
  ];
}

export function mergeBatches(state, input) {
  const sources = (input.source_batch_ids ?? []).map((id) => state.batches.get(id));
  if (!sources.length || sources.some((b) => !b)) throw new DomainError("not_found", "合并来源批次不存在", "source_batch_ids");
  if (sources.some((b) => b.status !== "active")) throw new DomainError("quantity_not_conserved", "只能合并活动批次", "source_batch_ids");
  const total = sources.reduce((n, b) => n + b.quantity, 0);
  if (input.quantity !== total) throw new DomainError("quantity_not_conserved", `合并数量不守恒：${total} != ${input.quantity}`, "quantity");
  if (state.batches.has(input.id)) throw new DomainError("already_exists", "合并后批次已存在", "id");
  return [
    envelope(state, "BATCH_MERGED", "work_batch", input.id, input.occurred_at, {
      source_batch_ids: input.source_batch_ids,
      quantity: input.quantity,
    }),
  ];
}

export function reworkBatch(state, input) {
  const source = state.batches.get(input.source_batch_id);
  if (!source) throw new DomainError("not_found", "返工来源批次不存在", "source_batch_id");
  if (source.status !== "active" || source.quantity !== input.quantity) {
    throw new DomainError("quantity_not_conserved", "返工必须整批且数量守恒", "quantity");
  }
  if (state.batches.has(input.id)) throw new DomainError("already_exists", "返工批次已存在", "id");
  return [
    envelope(state, "BATCH_REWORKED", "work_batch", input.id, input.occurred_at, {
      source_batch_id: input.source_batch_id,
      quantity: input.quantity,
      reason: input.reason,
    }),
  ];
}

// 作品批次溯源（拆分/合并/返工链）-> 最初的设计或制式依据。
export function batchRootBasis(state, batchId, seen = new Set()) {
  if (seen.has(batchId)) return null;
  seen.add(batchId);
  const batch = state.batches.get(batchId);
  if (!batch) return null;
  if (batch.basis.kind === "design" || batch.basis.kind === "standard") return { ...batch.basis };
  const parent = batch.basis.parents?.[0];
  if (batch.basis.kind === "batch_merge") {
    const roots = batch.basis.parents.map((pid) => batchRootBasis(state, pid, seen)).filter(Boolean);
    return roots.length === 1 ? roots[0] : { kind: "mixed", roots };
  }
  return parent ? batchRootBasis(state, parent, seen) : null;
}

export function registerItem(state, input) {
  const batch = state.batches.get(input.batch_id);
  if (!batch) throw new DomainError("not_found", "作品所属批次不存在", "batch_id");
  if (batch.status !== "active") throw new DomainError("batch_not_active", "作品只能登记在活动批次上", "batch_id");
  if (!input.contributor_ids?.length) throw new DomainError("contributors_required", "作品必须记录贡献人", "contributor_ids");
  const existingId = state.itemNoIndex.get(input.item_no);
  if (existingId) {
    const existing = state.items.get(existingId);
    const sameFingerprint = existing.content_fingerprint === input.content_fingerprint;
    const sameContributors = sameSet(existing.contributor_ids, input.contributor_ids);
    if (sameFingerprint && sameContributors) {
      // 编号、指纹、贡献人完全一致：幂等沿用原回执，不产生新事件。
      return { receipt_id: existingId, events: [] };
    }
    // 指纹或贡献人变化：绝不另发回执，锁定原作品进入复核。
    const events = [
      envelope(state, "ITEM_REVIEW_LOCKED", "work_item", existingId, input.occurred_at, {
        reason: sameFingerprint ? "contributors_changed" : "fingerprint_changed",
        detail: {
          attempted_batch_id: input.batch_id,
          expected_fingerprint: existing.content_fingerprint,
          actual_fingerprint: input.content_fingerprint,
          expected_contributors: existing.contributor_ids,
          actual_contributors: input.contributor_ids,
        },
      }),
    ];
    return { receipt_id: existingId, locked: true, events };
  }
  const root = batchRootBasis(state, input.batch_id) ?? { kind: "batch", batch_id: input.batch_id };
  const events = [
    envelope(state, "ITEM_REGISTERED", "work_item", input.id, input.occurred_at, {
      batch_id: input.batch_id,
      item_no: input.item_no,
      content_fingerprint: input.content_fingerprint,
      contributor_ids: input.contributor_ids,
      basis: { kind: "batch", batch_id: input.batch_id, root },
    }),
  ];
  return { receipt_id: input.id, events };
}

export function sellItem(state, input) {
  const item = state.items.get(input.id);
  if (!item) throw new DomainError("not_found", "作品不存在", "id");
  if (item.locks.length) throw new DomainError("item_locked", "作品处于复核锁定，不能售出", "id");
  if (item.sold_at) return [];
  if (item.basis.root?.kind === "design") {
    const check = designUsableAt(state, state.designs.get(item.basis.root.design_id), toTime(input.sold_at));
    if (!check.usable) throw new DomainError("sale_halted", `授权收窄后未售作品停止流通：${check.reason}`, "id");
  }
  return [envelope(state, "ITEM_SOLD", "work_item", input.id, input.occurred_at, { sold_at: input.sold_at })];
}

// 依据快照在批准时固定；批准动作本身要求当下引用仍然有效。
function buildBasis(state, subject) {
  if (subject.kind === "design") {
    const design = state.designs.get(subject.id);
    if (!design) throw new DomainError("not_found", "设计不存在", "subject_ref");
    return {
      kind: "design",
      design_id: design.id,
      designer_id: design.designer_id,
      content_fingerprint: design.content_fingerprint,
      frozen_at: design.frozen_at,
      approvals: design.approvals,
      grants: design.grant_snapshot,
    };
  }
  if (subject.kind === "item") {
    const item = state.items.get(subject.id);
    if (!item) throw new DomainError("not_found", "作品不存在", "subject_ref");
    const rootDesign = item.basis.root?.kind === "design" ? state.designs.get(item.basis.root.design_id) : null;
    return {
      kind: "item",
      item_id: item.id,
      item_no: item.item_no,
      batch_id: item.batch_id,
      content_fingerprint: item.content_fingerprint,
      contributor_ids: item.contributor_ids,
      root: item.basis.root,
      // 作品的公开说法同样冻结根设计当时的授权快照，供补正与审计回看。
      grants: rootDesign ? rootDesign.grant_snapshot : [],
    };
  }
  if (subject.kind === "standard") {
    const standard = state.standards.get(subject.id);
    if (!standard) throw new DomainError("not_found", "制式不存在", "subject_ref");
    return {
      kind: "standard",
      standard_id: standard.id,
      standard_version: standard.approved_version,
      signatures: standard.signatures,
    };
  }
  throw new DomainError("invalid_subject", "公开说明只能指向制式、设计或作品", "subject_ref");
}

function assertCitationUsable(state, ref, atMs) {
  if (ref.kind === "standard") {
    const standard = state.standards.get(ref.id);
    if (!standard?.approved_version) throw new DomainError("standard_not_recognized", `制式 ${ref.id} 未经认定`, "citations");
    return;
  }
  if (ref.kind === "design") {
    const design = state.designs.get(ref.id);
    const check = designUsableAt(state, design, atMs);
    if (!check.usable) throw new DomainError("citation_halted", `设计 ${ref.id} 已超出有效场合：${check.reason}`, "citations");
    return;
  }
  if (ref.kind === "item") {
    const item = state.items.get(ref.id);
    if (!item) throw new DomainError("not_found", `作品 ${ref.id} 不存在`, "citations");
    if (item.basis.root?.kind === "design") {
      const check = designUsableAt(state, state.designs.get(item.basis.root.design_id), atMs);
      if (!check.usable) throw new DomainError("citation_halted", `作品 ${ref.id} 已超出有效场合：${check.reason}`, "citations");
    }
    return;
  }
  throw new DomainError("invalid_citation", "课程引用只能是制式、设计或作品", "citations");
}

export function approveStatement(state, input) {
  const at = toTime(input.occurred_at);
  if (state.statements.has(input.id)) throw new DomainError("already_exists", "公开说明已存在", "id");
  const purpose = input.purpose ?? "public";
  // 补正说明正是在依据失效后开立，因此不再要求当下引用仍然有效；
  // 它仍要完整冻结原依据，回答“当时凭什么这么说”。
  if (purpose !== "correction") assertCitationUsable(state, input.subject_ref, at);
  if (purpose === "correction" && input.disposition_id) {
    requireExist(state, [{ kind: "disposition", id: input.disposition_id }]);
  }
  const basis = buildBasis(state, input.subject_ref);
  return [
    envelope(state, "STATEMENT_APPROVED", "public_statement", input.id, input.occurred_at, {
      subject_ref: input.subject_ref,
      audience: input.audience,
      context: input.context,
      title: input.title,
      claim: input.claim,
      basis,
      purpose,
      disposition_id: input.disposition_id ?? null,
    }),
  ];
}

export function citeCourse(state, input) {
  const at = toTime(input.occurred_at);
  if (state.courses.has(input.id)) throw new DomainError("already_exists", "课程已登记", "id");
  if (!input.citations?.length) throw new DomainError("citations_required", "课程必须至少引用一项谱系依据", "citations");
  for (const ref of input.citations) assertCitationUsable(state, ref, at);
  return [
    envelope(state, "COURSE_CITED", "course", input.id, input.occurred_at, {
      course_name: input.course_name,
      provider_id: input.provider_id,
      citations: input.citations,
    }),
  ];
}

export function endCourse(state, input) {
  const course = state.courses.get(input.id);
  if (!course) throw new DomainError("not_found", "课程不存在", "id");
  if (course.ended_at) return [];
  return [envelope(state, "COURSE_ENDED", "course", input.id, input.occurred_at, { ended_at: input.ended_at })];
}

// ---------- 定期发现：授权变化、受影响对象、未完成处置 ----------

function changedGrantAt(grant, asOfMs) {
  const withdrawAt = grant.withdrawal ? toTime(grant.withdrawal.effective_at) : null;
  const expireAt = toTime(grant.valid_until);
  if (withdrawAt !== null && withdrawAt <= asOfMs) {
    return { at: withdrawAt, scope_after: grant.withdrawal.replaces_scope ?? {}, trigger: "grant_narrowed" };
  }
  if (expireAt < asOfMs) return { at: expireAt, scope_after: {}, trigger: "grant_expired" };
  return null;
}

function designsOnGrant(state, grantId) {
  return [...state.designs.values()].filter((d) => d.grant_snapshot.some((s) => s.grant_id === grantId));
}

// 幂等键：同一授权、同一变化点、同一对象，只开一张处置单。
function dispositionId(runId, grantId, kind, refId) {
  return `disp-${runId}-${grantId}-${kind}-${refId}`.replace(/[^A-Za-z0-9_:.-]/g, "_");
}

export function planDiscovery(state, asOf) {
  const asOfMs = toTime(asOf);
  const planned = [];
  const openReminders = [];
  for (const grant of state.grants.values()) {
    const change = changedGrantAt(grant, asOfMs);
    if (!change) continue;
    const afterRefs = new Set([
      ...(change.scope_after.element_ids ?? []),
      ...(change.scope_after.process_version_ids ?? []),
      ...(change.scope_after.mold_ids ?? []),
    ]);
    for (const design of designsOnGrant(state, grant.id)) {
      const lostDesign =
        design.element_refs.some((r) => !afterRefs.has(r)) ||
        design.process_refs.some((r) => !afterRefs.has(r)) ||
        design.mold_refs.some((r) => !afterRefs.has(r));
      if (!lostDesign) continue;
      for (const item of state.items.values()) {
        if (item.basis.root?.design_id !== design.id) continue;
        planned.push({
          id: dispositionId("scan", grant.id, "item", item.id),
          trigger: change.trigger,
          grant_id: grant.id,
          scope_after: change.scope_after,
          affected: {
            kind: "item",
            id: item.id,
            sold: item.sold_at !== null,
            requires: item.sold_at !== null && toTime(item.sold_at) <= change.at ? "correction" : "stop_use",
          },
        });
      }
      for (const course of state.courses.values()) {
        const citesDesign = course.citations.some((c) => {
          if (c.kind === "design") return c.id === design.id;
          if (c.kind === "item") {
            return state.items.get(c.id)?.basis.root?.design_id === design.id;
          }
          return false;
        });
        if (!citesDesign) continue;
        planned.push({
          id: dispositionId("scan", grant.id, "course", course.id),
          trigger: change.trigger,
          grant_id: grant.id,
          scope_after: change.scope_after,
          affected: {
            kind: "course",
            id: course.id,
            ended: course.ended_at !== null,
            requires: course.ended_at !== null && toTime(course.ended_at) <= change.at ? "correction" : "stop_use",
          },
        });
      }
      for (const stmt of state.statements.values()) {
        const touches =
          (stmt.subject_ref.kind === "design" && stmt.subject_ref.id === design.id) ||
          (stmt.basis?.kind === "design" && stmt.basis.design_id === design.id) ||
          (stmt.basis?.kind === "item" && stmt.basis.root?.design_id === design.id) ||
          stmt.basis?.grants?.some((g) => g.grant_id === grant.id);
        if (touches) {
          planned.push({
            id: dispositionId("scan", grant.id, "statement", stmt.id),
            trigger: change.trigger,
            grant_id: grant.id,
            scope_after: change.scope_after,
            affected: { kind: "statement", id: stmt.id, sold: false, requires: "correction" },
          });
        }
      }
    }
  }
  for (const d of state.dispositions.values()) {
    if (!d.resolved_at) openReminders.push({ disposition_id: d.id, opened_at: d.opened_at });
  }
  // 去重：已经开立（含已由之前运行开立）的处置单不再重复计划。
  const fresh = [];
  const seen = new Set();
  for (const entry of planned) {
    if (seen.has(entry.id) || state.dispositions.has(entry.id)) continue;
    seen.add(entry.id);
    fresh.push(entry);
  }
  return { as_of: asOf, to_open: fresh, open_reminders: openReminders };
}

export function resolveDisposition(state, input) {
  const d = state.dispositions.get(input.id);
  if (!d) throw new DomainError("not_found", "处置单不存在", "id");
  if (d.resolved_at) throw new DomainError("already_resolved", "处置单已闭环", "id");
  const needsCorrection = d.affected.requires === "correction";
  if (needsCorrection && !input.correction_statement_id) {
    throw new DomainError("correction_required", "已售作品或已结束活动必须附带补正公开说明", "correction_statement_id");
  }
  if (input.correction_statement_id) {
    const correction = state.statements.get(input.correction_statement_id);
    if (!correction) throw new DomainError("not_found", "补正说明不存在", "correction_statement_id");
  }
  return [
    envelope(state, "DISPOSITION_RESOLVED", "disposition", input.id, input.occurred_at, {
      resolution: input.resolution,
      correction_statement_id: input.correction_statement_id ?? null,
      resolved_at: input.resolved_at,
    }),
  ];
}

// 扫描命令：支持崩溃恢复——同一 run_id 重新执行时严格沿用 RUN_STARTED 中的原计划。
export function runDiscovery(state, input) {
  const existing = state.runs.get(input.run_id);
  let plan;
  if (existing) {
    if (existing.finished) return { events: [], resumed: false, plan: existing.plan };
    plan = existing.plan;
  } else {
    plan = planDiscovery(state, input.as_of);
  }
  const rec = recorder(state);
  if (!existing) {
    rec.emit("RUN_STARTED", "discovery_run", input.run_id, input.occurred_at, { plan });
  }
  const opened = [];
  for (const entry of plan.to_open) {
    if (state.dispositions.has(entry.id)) continue; // 崩溃前已写入
    rec.emit("DISPOSITION_OPENED", "disposition", entry.id, input.occurred_at, {
      trigger: entry.trigger,
      grant_id: entry.grant_id,
      scope_after: entry.scope_after,
      affected: entry.affected,
      run_id: input.run_id,
    });
    opened.push(entry.id);
  }
  rec.emit("RUN_ADVANCED", "discovery_run", input.run_id, input.occurred_at, {
    step: "open_dispositions",
    disposition_ids: opened,
  });
  rec.emit("RUN_FINISHED", "discovery_run", input.run_id, input.occurred_at, {
    summary: {
      opened: opened.length,
      planned: plan.to_open.length,
      open_reminders: plan.open_reminders.length,
      recovered: Boolean(existing),
    },
  });
  return { events: rec.events, resumed: Boolean(existing), plan };
}
