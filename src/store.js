// 只追加（append-only）JSONL 事件存储。
// 保证：契约校验、按聚合的 expectedVersion 乐观并发、event_id 全局唯一、
// 以及 command_id 请求级幂等（副作用文件与事件日志同源落盘）。

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { validateEvent } from "./contracts.js";

export class ConcurrencyError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConcurrencyError";
    this.code = "concurrency_conflict";
  }
}

export class EventStore {
  constructor(path, schema) {
    this.path = path;
    this.schema = schema;
    this._commandIndexPath = `${path}.commands`;
    this._commandResults = null;
  }

  async readAll() {
    if (!existsSync(this.path)) return [];
    const raw = await readFile(this.path, "utf8");
    const events = [];
    raw.split("\n").forEach((line, i) => {
      if (!line.trim()) return;
      try {
        events.push(JSON.parse(line));
      } catch (cause) {
        throw new Error(`事件日志第 ${i + 1} 行不是合法 JSON`, { cause });
      }
    });
    return events;
  }

  async _loadCommandResults() {
    if (this._commandResults) return this._commandResults;
    const results = new Map();
    if (existsSync(this._commandIndexPath)) {
      const raw = await readFile(this._commandIndexPath, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        results.set(entry.command_id, entry.result);
      }
    }
    this._commandResults = results;
    return results;
  }

  async commandResult(commandId) {
    if (!commandId) return undefined;
    const results = await this._loadCommandResults();
    return results.get(commandId);
  }

  async append(events, options = {}) {
    if (!events.length) return { appended: 0 };
    for (const e of events) {
      const issues = validateEvent(e, this.schema);
      if (issues.length) {
        const detail = issues.map((i) => `${i.field} ${i.code}`).join("; ");
        throw new Error(`事件 ${e.event_id} 未通过契约校验：${detail}`);
      }
    }
    await mkdir(dirname(this.path), { recursive: true });

    // 以日志现状复核 event_id 唯一与聚合版本连续；append 前最后一道闸。
    const known = new Set();
    const versions = new Map();
    for (const existing of await this.readAll()) {
      known.add(existing.event_id);
      const key = `${existing.aggregate_type}:${existing.aggregate_id}`;
      versions.set(key, existing.version);
    }
    for (const e of events) {
      if (known.has(e.event_id)) throw new ConcurrencyError(`事件 ${e.event_id} 已存在`);
      known.add(e.event_id);
      const key = `${e.aggregate_type}:${e.aggregate_id}`;
      const expected = (versions.get(key) ?? 0) + 1;
      if (e.version !== expected) {
        throw new ConcurrencyError(`聚合 ${key} 期望版本 ${expected}，得到 ${e.version}`);
      }
      versions.set(key, e.version);
    }

    const block = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await appendFile(this.path, block, "utf8");

    if (options.commandId !== undefined && options.result !== undefined) {
      const entry = { command_id: options.commandId, at: new Date().toISOString(), result: options.result };
      await appendFile(this._commandIndexPath, `${JSON.stringify(entry)}\n`, "utf8");
      const results = await this._loadCommandResults();
      results.set(options.commandId, options.result);
    }
    return { appended: events.length };
  }
}
