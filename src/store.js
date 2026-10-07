import { readFile, writeFile } from "node:fs/promises";

// 事件与定期任务记录的持久化。内存实现用于测试，文件实现用于进程重启后恢复。
export function createMemoryStore() {
  const data = { events: [], sweeps: [] };
  return {
    async readEvents() {
      return data.events.map((event) => structuredClone(event));
    },
    async appendEvent(event) {
      data.events.push(structuredClone(event));
    },
    async readSweeps() {
      return data.sweeps.map((sweep) => structuredClone(sweep));
    },
    async saveSweep(sweep) {
      const index = data.sweeps.findIndex((item) => item.sweep_id === sweep.sweep_id);
      if (index >= 0) data.sweeps[index] = structuredClone(sweep);
      else data.sweeps.push(structuredClone(sweep));
    },
  };
}

export async function openFileStore(path) {
  let data;
  try {
    data = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    data = { events: [], sweeps: [] };
  }
  data.events ??= [];
  data.sweeps ??= [];
  const persist = () => writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return {
    async readEvents() {
      return data.events.map((event) => structuredClone(event));
    },
    async appendEvent(event) {
      data.events.push(structuredClone(event));
      await persist();
    },
    async readSweeps() {
      return data.sweeps.map((sweep) => structuredClone(sweep));
    },
    async saveSweep(sweep) {
      const index = data.sweeps.findIndex((item) => item.sweep_id === sweep.sweep_id);
      if (index >= 0) data.sweeps[index] = structuredClone(sweep);
      else data.sweeps.push(structuredClone(sweep));
      await persist();
    },
  };
}
