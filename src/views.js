// 读模型：按受众提供最小必要信息。
// - consumer：消费者，回答造型来源、认可者、当前有效场合。
// - provider：授课机构，回答课程引用是否仍可使用、何时到期。
// - audit：内部审计，从任一作品回看工序、师承、贡献与历次公开身份。

import { designUsableAt, effectiveScopeAt, toTime } from "./domain.js";

function nameOf(entity) {
  return entity?.name ?? entity?.course_name ?? null;
}

function statusOf(state, design, asOfMs) {
  const check = designUsableAt(state, design, asOfMs);
  if (check.usable) return { usable: true };
  return { usable: false, reason: check.reason, missing: check.missing ?? [] };
}

// 找到与某对象相关的最新补正说明（经处置单挂接）。
function correctionFor(state, target) {
  const result = [];
  for (const d of state.dispositions.values()) {
    const isTarget =
      (target.kind === "item" && d.affected?.kind === "item" && d.affected.id === target.id) ||
      (target.kind === "course" && d.affected?.kind === "course" && d.affected.id === target.id) ||
      (target.kind === "design" && d.affected?.id === target.id);
    if (isTarget && d.correction_statement_id) {
      result.push({
        disposition_id: d.id,
        statement_id: d.correction_statement_id,
        resolved_at: d.resolved_at,
      });
    }
  }
  return result;
}

export function consumerView(state, query, asOf) {
  const asOfMs = toTime(asOf);
  const item = query.item_id ? state.items.get(query.item_id) : state.items.get(state.itemNoIndex.get(query.item_no));
  if (!item) return null;
  const root = item.basis.root;
  const statements = state.statementsBySubject.get(`item:${item.id}`) ?? [];

  const view = {
    audience: "consumer",
    as_of: asOf,
    item_no: item.item_no,
    batch_id: item.batch_id,
    origin: null,
    recognized_by: [],
    validity: null,
    public_claims: statements
      .filter((s) => s.purpose !== "correction")
      .map((s) => ({ statement_id: s.id, context: s.context, title: s.title, claim: s.claim, approved_at: s.approved_at })),
    corrections: [],
  };

  if (root?.kind === "design") {
    const design = state.designs.get(root.design_id);
    view.origin = {
      kind: "design",
      design_id: design.id,
      designer_id: design.designer_id,
      content_fingerprint: design.content_fingerprint,
      frozen_at: design.frozen_at,
      classic_elements: design.element_refs.map((id) => ({ id, name: nameOf(state.elements.get(id)) })),
      process_versions: design.process_refs.map((id) => ({
        id,
        standard_id: state.processes.get(id)?.standard_id ?? null,
        steps: state.processes.get(id)?.steps ?? [],
      })),
      molds: design.mold_refs.map((id) => ({ id, origin: state.molds.get(id)?.origin ?? null })),
      lineage: design.grant_snapshot.map((g) => ({ grant_id: g.grant_id, grantor_id: g.grantor_id, valid_until: g.valid_until })),
    };
    view.recognized_by = design.approvals.map((a) => ({
      reviewer_kind: a.reviewer_kind === "craft" ? "技艺类审核者" : "民俗类审核者",
      reviewer_id: a.reviewer_id,
      signed_at: a.signed_at,
    }));
    const st = statusOf(state, design, asOfMs);
    view.validity = st.usable
      ? { status: "有效", contexts: ["门店", "展会", "课堂"] }
      : { status: "已超出原授权范围", reason: st.reason, sold_basis_retained: true };
  } else if (root?.kind === "standard") {
    const standard = state.standards.get(root.standard_id);
    view.origin = {
      kind: "standard",
      standard_id: standard.id,
      name: standard.name,
      tradition: standard.tradition,
      version: root.standard_version,
      classic_elements: standard.element_ids.map((id) => ({ id, name: nameOf(state.elements.get(id)) })),
      process_versions: standard.process_version_ids.map((id) => ({ id, steps: state.processes.get(id)?.steps ?? [] })),
    };
    view.recognized_by = standard.signatures.map((s) => ({
      reviewer_kind: s.reviewer_kind === "craft" ? "技艺类审核者" : "民俗类审核者",
      reviewer_id: s.reviewer_id,
      signed_at: s.signed_at,
    }));
    view.validity = { status: "传统制式认定有效", contexts: ["门店", "展会", "课堂"] };
  }

  view.corrections = correctionFor(state, { kind: "item", id: item.id }).map((c) => {
    const stmt = state.statements.get(c.statement_id);
    return {
      statement_id: c.statement_id,
      title: stmt?.title ?? null,
      claim: stmt?.claim ?? null,
      resolved_at: c.resolved_at,
    };
  });
  return view;
}

function citationEntry(state, ref, asOfMs) {
  if (ref.kind === "standard") {
    const standard = state.standards.get(ref.id);
    return { ref, recognized: Boolean(standard?.approved_version), usable: true, detail: { version: standard?.approved_version ?? null } };
  }
  if (ref.kind === "design") {
    const design = state.designs.get(ref.id);
    const check = designUsableAt(state, design, asOfMs);
    const grants = design?.grant_snapshot ?? [];
    return {
      ref,
      recognized: Boolean(design?.approved),
      usable: check.usable,
      reason: check.usable ? null : check.reason,
      earliest_expiry: grants.map((g) => g.valid_until).sort()[0] ?? null,
    };
  }
  if (ref.kind === "item") {
    const item = state.items.get(ref.id);
    const root = item?.basis.root;
    if (root?.kind === "design") {
      const check = designUsableAt(state, state.designs.get(root.design_id), asOfMs);
      return { ref, recognized: true, usable: check.usable, reason: check.usable ? null : check.reason, item_no: item.item_no };
    }
    return { ref, recognized: true, usable: true, item_no: item?.item_no ?? null };
  }
  return { ref, recognized: false, usable: false, reason: "unknown_ref" };
}

export function providerView(state, query, asOf) {
  const asOfMs = toTime(asOf);
  const courses = query.course_id
    ? [state.courses.get(query.course_id)].filter(Boolean)
    : [...state.courses.values()].filter((c) => c.provider_id === query.provider_id);
  return courses.map((course) => {
    const citations = course.citations.map((ref) => citationEntry(state, ref, asOfMs));
    const usable = citations.every((c) => c.usable);
    const openDispositions = [...state.dispositions.values()].filter(
      (d) => !d.resolved_at && d.affected?.kind === "course" && d.affected.id === course.id,
    );
    return {
      audience: "provider",
      as_of: asOf,
      course_id: course.id,
      course_name: course.course_name,
      status: course.ended_at ? "已结束（保留原依据）" : usable ? "可开课" : "停止使用",
      can_use: usable && !course.ended_at,
      citations,
      open_dispositions: openDispositions.map((d) => ({ disposition_id: d.id, trigger: d.trigger, requires: d.affected.requires })),
      ended_at: course.ended_at,
    };
  });
}

// ---------- 内部审计：从作品回溯整条谱系 ----------

function batchChain(state, batchId, out = { nodes: [], links: [] }, seen = new Set()) {
  if (seen.has(batchId)) return out;
  seen.add(batchId);
  const batch = state.batches.get(batchId);
  if (!batch) return out;
  out.nodes.push({ batch_id: batch.id, quantity: batch.quantity, status: batch.status, basis: batch.basis });
  const parents = batch.basis.parents ?? [];
  for (const pid of parents) {
    out.links.push({ from: pid, to: batch.id, via: batch.basis.kind });
    batchChain(state, pid, out, seen);
  }
  return out;
}

function eventsForChain(events, idsByType) {
  return events.filter((e) => {
    if (idsByType[e.aggregate_type]?.has(e.aggregate_id)) return true;
    // 批次拆分事件挂在来源批次上，载荷里提到链上批次也纳入。
    if (e.aggregate_type === "work_batch") {
      const p = e.payload;
      const mentions = [p.source_batch_id, ...(p.source_batch_ids ?? []), ...(p.splits?.map((s) => s.batch_id) ?? [])];
      return mentions.some((id) => idsByType.work_batch?.has(id));
    }
    if (e.aggregate_type === "work_item" && idsByType.work_item?.has(e.aggregate_id)) return true;
    return false;
  });
}

export function auditView(state, events, query) {
  const item = query.item_id ? state.items.get(query.item_id) : state.items.get(state.itemNoIndex.get(query.item_no));
  if (!item) return null;
  const root = item.basis.root;
  const chain = batchChain(state, item.batch_id);

  const grants = [];
  let design = null;
  let standard = null;
  if (root?.kind === "design") {
    design = state.designs.get(root.design_id);
    for (const snap of design.grant_snapshot) {
      const g = state.grants.get(snap.grant_id);
      grants.push({
        grant_id: g.id,
        grantor_id: g.grantor_id,
        grantee_id: g.grantee_id,
        valid_from: g.valid_from,
        valid_until: g.valid_until,
        withdrawal: g.withdrawal,
        effective_now: effectiveScopeAt(g, toTime(new Date().toISOString())) ? true : false,
      });
    }
  } else if (root?.kind === "standard") {
    standard = state.standards.get(root.standard_id);
  }

  const subjectKey = `item:${item.id}`;
  const statements = (state.statementsBySubject.get(subjectKey) ?? []).map((s) => ({
    statement_id: s.id,
    purpose: s.purpose,
    audience: s.audience,
    context: s.context,
    title: s.title,
    claim: s.claim,
    approved_at: s.approved_at,
    disposition_id: s.disposition_id,
  }));

  const idsByType = {
    work_item: new Set([item.id]),
    work_batch: new Set(chain.nodes.map((n) => n.batch_id)),
  };
  if (design) idsByType.design = new Set([design.id]);
  if (standard) idsByType.craft_standard = new Set([standard.id]);
  const relatedEvents = eventsForChain(events ?? [], idsByType);

  return {
    audience: "audit",
    item: {
      item_id: item.id,
      item_no: item.item_no,
      content_fingerprint: item.content_fingerprint,
      contributor_ids: item.contributor_ids,
      batch_id: item.batch_id,
      sold_at: item.sold_at,
      locks: item.locks,
      registered_at: item.registered_at,
    },
    root,
    design: design
      ? {
          design_id: design.id,
          designer_id: design.designer_id,
          frozen_at: design.frozen_at,
          approvals: design.approvals,
          grant_snapshot: design.grant_snapshot,
          element_ids: design.element_refs,
          process_ids: design.process_refs,
          mold_ids: design.mold_refs,
        }
      : null,
    standard: standard
      ? { standard_id: standard.id, version: standard.version, signatures: standard.signatures }
      : null,
    grants,
    processes: (design ?? standard)
      ? [...new Set(design ? design.process_refs : standard.process_version_ids)].map((id) => state.processes.get(id))
      : [],
    molds: design ? design.mold_refs.map((id) => state.molds.get(id)) : [],
    batch_genealogy: chain,
    quantity_conservation: chain.links.every((l) => l.via.startsWith("batch_"))
      ? "链上拆分/合并/返工事件均通过数量守恒校验"
      : null,
    public_identity_history: statements,
    dispositions: [...state.dispositions.values()]
      .filter((d) => d.affected?.id === item.id || statements.some((s) => s.disposition_id === d.id))
      .map((d) => ({
        disposition_id: d.id,
        trigger: d.trigger,
        grant_id: d.grant_id,
        requires: d.affected.requires,
        opened_at: d.opened_at,
        resolved_at: d.resolved_at,
        resolution: d.resolution,
        correction_statement_id: d.correction_statement_id,
      })),
    event_refs: relatedEvents.map((e) => ({
      event_id: e.event_id,
      event_type: e.event_type,
      aggregate_type: e.aggregate_type,
      aggregate_id: e.aggregate_id,
      version: e.version,
      occurred_at: e.occurred_at,
    })),
  };
}
