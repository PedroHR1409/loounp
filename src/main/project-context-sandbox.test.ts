import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ADAPTER_VERSION,
  checkIsolation,
  isolationPolicy,
  IsolationError,
  POLICY_SHA256,
  readWorkerFile,
  runtimeSha256,
  SandboxSupervisor,
  workerCommand,
  type SandboxEnvironment,
} from "./project-context-sandbox";

let base: string;
let env: SandboxEnvironment;
let flag: boolean;

async function makeRuntime(root: string) {
  await mkdir(join(root, "venv", "Scripts"), { recursive: true });
  await mkdir(join(root, "worker"), { recursive: true });
  for (const file of [
    join(root, "venv", "Scripts", "python.exe"),
    join(root, "worker", "lowil_launcher.py"),
    join(root, "worker", "worker.py"),
  ])
    await writeFile(file, "");
  await writeFile(
    join(root, "runtime-manifest.json"),
    JSON.stringify({ python: "3.14", files: [] }),
  );
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "a2p-sandbox-"));
  for (const folder of ["Projetos", "feature", "low"])
    await mkdir(join(base, folder));
  await makeRuntime(join(base, "runtime"));
  flag = true;
  env = {
    platform: "win32",
    runtimeDirectory: join(base, "runtime"),
    featureDirectory: join(base, "feature"),
    lowDirectory: join(base, "low"),
    sourceRoot: join(base, "Projetos"),
    protectedRoot: join(base, "Projetos"),
    realSourcesEnabled: () => flag,
  };
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function approve(overrides: Record<string, string> = {}) {
  await writeFile(
    join(base, "feature", "gate-approval.json"),
    JSON.stringify({
      suiteVersion: "gate0-v2",
      runtimeSha256: await runtimeSha256(env.runtimeDirectory),
      adapterVersion: ADAPTER_VERSION,
      policySha256: POLICY_SHA256,
      approvedAt: "2026-09-23T12:00:00Z",
      ...overrides,
    }),
  );
}

describe("low-integrity isolation policy", () => {
  it("launches the worker through the low-integrity launcher with job limits and a LocalLow workdir", () => {
    const { command, args } = workerCommand(env, {
      input: "I",
      exchange: "E",
      workdir: "W",
    });
    expect(command).toBe(
      join(base, "runtime", "venv", "Scripts", "python.exe"),
    );
    expect(args.slice(0, 2)).toEqual([
      "-I",
      join(base, "runtime", "worker", "lowil_launcher.py"),
    ]);
    expect(args).toEqual(
      expect.arrayContaining([
        "--entry",
        join(base, "runtime", "worker", "worker.py"),
        "--workdir",
        "W",
        "--memory-mb",
        "4096",
        "--source",
        join(base, "Projetos"),
      ]),
    );
    expect(isolationPolicy.integrityLevel).toBe("S-1-16-4096");
    expect(isolationPolicy.job.killOnClose).toBe(true);
  });

  it("pins the policy hash passed to the Gate 0 suite; any policy change requires a new approval", () => {
    expect(POLICY_SHA256).toBe(
      "a1d3273dad75fed20145298b3289da1252a6d80192748e9860ae62ae2087d13c",
    );
  });
});

describe("isolation gate (AT-10)", () => {
  it("fails closed when the runtime is missing", async () => {
    const status = await checkIsolation({
      ...env,
      runtimeDirectory: join(base, "none"),
    });
    expect(status.state).toBe("unavailable");
    expect(status.reasons.join(" ")).toContain("package-project-context.ps1");
  });

  it("blocks until Gate 0 approves and whenever runtime, adapter or policy change", async () => {
    expect((await checkIsolation(env)).state).toBe("blocked");
    await approve({ policySha256: "f".repeat(64) });
    expect((await checkIsolation(env)).state).toBe("blocked");
    await approve();
    expect((await checkIsolation(env)).state).toBe("ready");
    await writeFile(
      join(base, "runtime", "runtime-manifest.json"),
      JSON.stringify({ python: "3.14", files: ["tampered"] }),
    );
    expect((await checkIsolation(env)).state).toBe("blocked");
  });

  it("respects the real-sources flag and refuses runtime or LocalLow areas inside the protected root", async () => {
    await approve();
    flag = false;
    expect((await checkIsolation(env)).state).toBe("disabled");
    flag = true;
    await makeRuntime(join(base, "Projetos", "rt"));
    expect(
      (
        await checkIsolation({
          ...env,
          runtimeDirectory: join(base, "Projetos", "rt"),
        })
      ).state,
    ).toBe("unavailable");
    expect(
      (
        await checkIsolation({
          ...env,
          lowDirectory: join(base, "Projetos", "low"),
        })
      ).state,
    ).toBe("unavailable");
  });

  it("refuses to start while isolation is not ready", async () => {
    const supervisor = new SandboxSupervisor({
      ...env,
      spawn: () => {
        throw new Error("must not spawn");
      },
    });
    await expect(supervisor.run("catalog", {})).rejects.toThrow("Gate 0");
  });
});

describe("exchange validation", () => {
  it("rejects unexpected names, foreign jobs and oversized files", async () => {
    const exchange = join(base, "exchange");
    await mkdir(exchange);
    await expect(
      readWorkerFile(exchange, "../gate-approval.json", {
        jobId: "job_a",
        seq: 1,
      }),
    ).rejects.toThrow("não permitido");
    await writeFile(
      join(exchange, "status.json"),
      JSON.stringify({
        contract: "v1",
        jobId: "job_old",
        seq: 1,
        state: "completed",
      }),
    );
    await expect(
      readWorkerFile(exchange, "status.json", { jobId: "job_new", seq: 1 }),
    ).rejects.toThrow("outro job");
    await writeFile(join(exchange, "heartbeat.json"), "x".repeat(70 * 1024));
    await expect(
      readWorkerFile(exchange, "heartbeat.json", { jobId: "job_new", seq: 1 }),
    ).rejects.toThrow("limite");
  });
});

function fakeChild(): ChildProcess & EventEmitter {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  Object.assign(child, { pid: 4242, exitCode: null, kill: () => true });
  return child;
}

const argAfter = (args: string[], flagName: string) =>
  args[args.indexOf(flagName) + 1];

describe("supervisor lifecycle", () => {
  it("runs a job through the LocalLow exchange, then removes both job directories", async () => {
    await approve();
    const supervisor = new SandboxSupervisor({
      ...env,
      sleep: async () => undefined,
      spawn: (_command, args) => {
        void (async () => {
          const request = JSON.parse(
            await readFile(
              join(argAfter(args, "--input"), "request.json"),
              "utf8",
            ),
          );
          const write = (name: string, body: object) =>
            writeFile(
              join(argAfter(args, "--exchange"), name),
              JSON.stringify({
                contract: "v1",
                jobId: request.jobId,
                seq: request.seq,
                ...body,
              }),
            );
          await write("project-0.json", {
            project: { key: "radar" },
            files: [],
            chunks: [],
          });
          await write("response.json", {
            state: "completed",
            projects: [{ key: "radar", file: "project-0.json" }],
          });
          await write("status.json", { state: "completed" });
        })();
        expect(argAfter(args, "--exchange").startsWith(join(base, "low"))).toBe(
          true,
        );
        return fakeChild();
      },
    });
    const result = await supervisor.run("catalog", {});
    expect(result.response.state).toBe("completed");
    expect(Object.keys(result.projectFiles)).toEqual(["project-0.json"]);
    expect(await readdir(join(base, "feature", "jobs"))).toEqual([]);
    expect(await readdir(join(base, "low", "jobs"))).toEqual([]);
    expect(supervisor.busy).toBe(false);
  });

  it("fails when the worker stops sending heartbeats and never fabricates results (AT-15)", async () => {
    await approve();
    let clock = 0;
    const supervisor = new SandboxSupervisor({
      ...env,
      now: () => clock,
      sleep: async () => {
        clock += 10_000;
      },
      spawn: (_command, args) => {
        void writeFile(
          join(argAfter(args, "--exchange"), "heartbeat.json"),
          "pending",
        );
        return fakeChild();
      },
    });
    await expect(supervisor.run("catalog", {})).rejects.toThrow(IsolationError);
  });

  it("fails immediately when the isolated process exits without a result", async () => {
    await approve();
    const supervisor = new SandboxSupervisor({
      ...env,
      sleep: async () => undefined,
      spawn: () => {
        const child = fakeChild();
        setTimeout(() => child.emit("exit", 91), 0);
        return child;
      },
    });
    await expect(supervisor.run("catalog", {})).rejects.toThrow(
      "terminou sem publicar",
    );
  });

  it("cancels through an abort signal", async () => {
    await approve();
    const controller = new AbortController();
    const supervisor = new SandboxSupervisor({
      ...env,
      sleep: async () => {
        controller.abort();
      },
      spawn: () => fakeChild(),
    });
    await expect(
      supervisor.run("catalog", {}, { signal: controller.signal }),
    ).rejects.toThrow("cancelada");
  });
});
