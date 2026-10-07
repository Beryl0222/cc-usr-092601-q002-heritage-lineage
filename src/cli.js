#!/usr/bin/env node
// 用法：
//   node src/cli.js validate <schema.json> <event.json>
//   node src/cli.js command  --store <events.jsonl> --name <命令名> --input <json|@file> [--command-id <id>]
//   node src/cli.js view <consumer|provider|audit> --store <events.jsonl>
//        [--item-id ID | --item-no 编号 | --course-id ID | --provider-id ID] --as-of <带时区时间>
//   node src/cli.js plan  --store <events.jsonl> --as-of <时间>
//   node src/cli.js scan  --store <events.jsonl> --run-id <id> --as-of <时间> [--resume]

import { readFile } from "node:fs/promises";

import { validateEvent } from "./contracts.js";
import { EventStore } from "./store.js";
import { LineageService } from "./service.js";
import { auditView, consumerView, providerView } from "./views.js";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else {
        args[key] = next;
        i += 1;
      }
    } else args._.push(token);
  }
  return args;
}

async function readJsonInput(value) {
  if (value === true || value === undefined) return {};
  const text = value.startsWith("@") ? await readFile(value.slice(1), "utf8") : value;
  return JSON.parse(text);
}

async function loadSchema() {
  return JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
}

async function runValidate(rest) {
  // 兼容旧用法 validate <schema.json> <event.json> 与新用法 validate <event.json>。
  const eventPath = rest[1] ?? rest[0];
  if (!eventPath) {
    console.error("用法: node src/cli.js validate <event.json> [schema.json]");
    process.exitCode = 2;
    return;
  }
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const issues = validateEvent(event, schema);
  if (issues.length === 0) console.log("valid");
  else {
    for (const issue of issues) console.log(`${issue.field}\t${issue.code}\t${issue.message}`);
    process.exitCode = 1;
  }
}

async function runCommand(args) {
  if (!args.store || !args.name) throw new Error("command 需要 --store 与 --name");
  const schema = await loadSchema();
  const service = new LineageService(new EventStore(args.store, schema));
  const input = await readJsonInput(args.input);
  const result = await service.dispatch(args.name, input, { command_id: args["command-id"] || undefined });
  console.log(JSON.stringify(result, null, 2));
}

async function runView(kind, args) {
  if (!args.store) throw new Error("view 需要 --store");
  const schema = await loadSchema();
  const store = new EventStore(args.store, schema);
  const service = new LineageService(store);
  const state = await service.state();
  const asOf = args["as-of"] ?? new Date().toISOString();
  const query = {
    item_id: args["item-id"],
    item_no: args["item-no"],
    course_id: args["course-id"],
    provider_id: args["provider-id"],
  };
  let view;
  if (kind === "consumer") view = consumerView(state, query, asOf);
  else if (kind === "provider") view = providerView(state, query, asOf);
  else if (kind === "audit") view = auditView(state, await store.readAll(), query);
  else throw new Error(`未知视图 ${kind}`);
  if (view === null) {
    console.error("未找到对应对象");
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(view, null, 2));
}

async function runScan(args, execute) {
  if (!args.store || !args["as-of"] || (execute && !args["run-id"])) {
    throw new Error(execute ? "scan 需要 --store、--run-id、--as-of" : "plan 需要 --store、--as-of");
  }
  const schema = await loadSchema();
  const service = new LineageService(new EventStore(args.store, schema));
  if (execute) {
    const result = await service.runDiscovery({
      run_id: args["run-id"],
      as_of: args["as-of"],
      occurred_at: new Date().toISOString(),
    });
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(JSON.stringify(await service.planDiscovery(args["as-of"]), null, 2));
  }
}

const args = parseArgs(process.argv.slice(2));
const [sub, ...rest] = args._;
try {
  if (sub === "validate") await runValidate(rest);
  else if (sub === "command") await runCommand(args);
  else if (sub === "view") await runView(rest[0], args);
  else if (sub === "scan") await runScan(args, true);
  else if (sub === "plan") await runScan(args, false);
  else {
    console.error("未知子命令。可用：validate | command | view <consumer|provider|audit> | plan | scan");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.code ?? "error", message: error.message }, null, 2));
  process.exitCode = 1;
}
