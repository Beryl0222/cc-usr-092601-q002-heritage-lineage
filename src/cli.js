import { readFile } from "node:fs/promises";

import { validateEvent } from "./contracts.js";
import { createLineageService } from "./service.js";
import { openFileStore } from "./store.js";

const [, , command, ...args] = process.argv;

async function loadSchema() {
  return JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
}

async function openService(storePath) {
  return createLineageService({ store: await openFileStore(storePath), schema: await loadSchema() });
}

function fail(message, code = 1) {
  console.error(message);
  process.exitCode = code;
}

async function main() {
  if (command === "audit") {
    const [storePath, workId] = args;
    if (!storePath || !workId) return fail("用法: node src/cli.js audit <store.json> <work_id>", 2);
    const service = await openService(storePath);
    console.log(JSON.stringify(service.auditTrace(workId), null, 2));
    return;
  }
  if (command === "view") {
    const [channel, storePath, id] = args;
    if (!["consumer", "institution"].includes(channel) || !storePath || !id) {
      return fail("用法: node src/cli.js view <consumer|institution> <store.json> <id>", 2);
    }
    const service = await openService(storePath);
    const view = channel === "consumer" ? service.consumerView(id) : service.institutionView(id);
    console.log(JSON.stringify(view, null, 2));
    return;
  }
  if (command === "sweep") {
    const [storePath, sweepId, plannedAt] = args;
    if (!storePath || !sweepId || !plannedAt) {
      return fail("用法: node src/cli.js sweep <store.json> <sweep_id> <planned_at>", 2);
    }
    const service = await openService(storePath);
    await service.resumeSweeps();
    let record = (await service.listSweeps()).find((sweep) => sweep.sweep_id === sweepId);
    record ??= await service.planSweep({ sweep_id: sweepId, planned_at: plannedAt });
    if (record.status !== "done") record = await service.runSweep(sweepId);
    console.log(JSON.stringify(record, null, 2));
    return;
  }
  const [schemaPath, eventPath] = [command, ...args];
  if (!schemaPath || !eventPath) {
    return fail("用法: node src/cli.js <schema.json> <event.json>\n      node src/cli.js <audit|view|sweep> ...", 2);
  }
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const issues = validateEvent(event, schema);
  if (issues.length === 0) console.log("valid");
  else {
    for (const issue of issues) console.log(`${issue.field}\t${issue.code}\t${issue.message}`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  fail(error.code ? `${error.code}: ${error.message}` : String(error));
}
