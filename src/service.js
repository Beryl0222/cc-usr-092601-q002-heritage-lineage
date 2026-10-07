// 服务门面：命令分发（command -> domain.decide -> store.append）、状态快照、扫描入口。
// 每次命令都从事件日志重建状态；本仓库规模下保持简单且无缓存一致性问题。

import * as domain from "./domain.js";
import { EventStore } from "./store.js";

const COMMANDS = {
  register_element: domain.registerElement,
  record_mold: domain.recordMold,
  record_standard: domain.recordStandard,
  sign_standard: domain.signStandard,
  record_process_version: domain.recordProcessVersion,
  issue_grant: domain.issueGrant,
  withdraw_grant: domain.withdrawGrant,
  freeze_design: domain.freezeDesign,
  approve_design: domain.approveDesign,
  create_batch: domain.createBatch,
  split_batch: domain.splitBatch,
  merge_batches: domain.mergeBatches,
  rework_batch: domain.reworkBatch,
  register_item: domain.registerItem,
  sell_item: domain.sellItem,
  approve_statement: domain.approveStatement,
  cite_course: domain.citeCourse,
  end_course: domain.endCourse,
  resolve_disposition: domain.resolveDisposition,
};

export class LineageService {
  constructor(store) {
    if (!(store instanceof EventStore)) throw new Error("LineageService 需要 EventStore 实例");
    this.store = store;
  }

  async state() {
    return domain.reduce(await this.store.readAll());
  }

  async dispatch(commandName, input, options = {}) {
    const handler = COMMANDS[commandName];
    if (!handler) throw new Error(`未知命令 ${commandName}`);
    if (options.command_id) {
      const cached = await this.store.commandResult(options.command_id);
      if (cached !== undefined) return { idempotent_replay: true, ...cached };
    }
    const state = await this.state();
    const outcome = handler(state, input);
    // registerItem 返回 {receipt_id, events, locked?}；其余命令直接返回事件数组。
    const events = outcome?.events ?? outcome;
    const result = outcome?.events
      ? { receipt_id: outcome.receipt_id, locked: Boolean(outcome.locked), event_ids: events.map((e) => e.event_id) }
      : { event_ids: events.map((e) => e.event_id) };
    await this.store.append(events, {
      commandId: options.command_id,
      result: options.command_id ? result : undefined,
    });
    return result;
  }

  // 定时发现：计划（不落盘）或执行（落盘，支持 run_id 恢复）。
  async planDiscovery(asOf) {
    return domain.planDiscovery(await this.state(), asOf);
  }

  async runDiscovery(input) {
    const state = await this.state();
    const outcome = domain.runDiscovery(state, input);
    await this.store.append(outcome.events);
    return { resumed: outcome.resumed, plan: outcome.plan, event_ids: outcome.events.map((e) => e.event_id) };
  }
}
