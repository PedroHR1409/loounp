import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { limits } from "../../core/project-ideas/contracts";
import {
  assertSafeExternalPath,
  atomicWrite,
  isInside,
} from "./store";

export const ADAPTER_VERSION = "graphify-adapter-v1";
export const WORKER_CONTRACT = "v1";
export const GATE_SUITE_VERSION = "gate0-v4";
const MAX_WORKER_FILE_BYTES = 96 * 1024 * 1024;
const MAX_SMALL_FILE_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_FILES = 20_000;
const WORKER_FILE = /^(heartbeat|status|response|project-\d{1,3})\.json$/;
const JOB_ID = /^job_[A-Za-z0-9_-]{8,64}$/;

export const isolationPolicy = {
  mechanism: "low-integrity-token+appcontainer+job-object",
  integrityLevel: "S-1-16-4096",
  job: {
    killOnClose: true,
    memoryMb: limits.worker.memoryMb,
    maxProcesses: 8,
    uiRestrictions: "all-basic",
  },
  writable: ["LocalLow job directory", "ephemeral AppContainer profile"],
  network: "appcontainer-no-capabilities+python-audit-hook",
  processes: "fixed-graphify-invocation-only",
  environment: "minimal-no-credentials",
} as const;

export const POLICY_SHA256 = createHash("sha256")
  .update(JSON.stringify(isolationPolicy))
  .digest("hex");

export type IsolationStatus = {
  state: "ready" | "unavailable" | "blocked" | "disabled";
  reasons: string[];
  runtimeSha256: string | null;
};
export type GateApproval = {
  suiteVersion: string;
  runtimeSha256: string;
  adapterVersion: string;
  policySha256: string;
  approvedAt: string;
};
export type WorkerOp = "catalog" | "retrieve" | "revalidate";
export type WorkerResult = {
  response: Record<string, unknown>;
  projectFiles: Record<string, unknown>;
};

export class IsolationError extends Error {}

export type SandboxEnvironment = {
  platform: NodeJS.Platform;
  runtimeDirectory: string;
  featureDirectory: string;
  lowDirectory: string;
  sourceRoot: string;
  protectedRoot: string;
  realSourcesEnabled: () => boolean;
  spawn?: (command: string, args: string[]) => ChildProcess;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export const runtimePaths = (runtimeDirectory: string) => ({
  python: join(runtimeDirectory, "venv", "Scripts", "python.exe"),
  launcher: join(runtimeDirectory, "worker", "lowil_launcher.py"),
  worker: join(runtimeDirectory, "worker", "worker.py"),
  manifest: join(runtimeDirectory, "runtime-manifest.json"),
});

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function runtimeSha256(
  runtimeDirectory: string,
): Promise<string | null> {
  try {
    const path = runtimePaths(runtimeDirectory).manifest;
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_MANIFEST_BYTES)
      return null;
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch {
    return null;
  }
}

type RuntimeManifestFile = { path: string; sha256: string; bytes: number };

async function verifyRuntimeFiles(runtimeDirectory: string): Promise<string[]> {
  const errors: string[] = [];
  const root = resolve(runtimeDirectory);
  const manifestPath = runtimePaths(root).manifest;
  let manifest: unknown;
  try {
    const info = await lstat(manifestPath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_MANIFEST_BYTES)
      return ["Manifesto do runtime inválido ou excede o limite."];
    manifest = JSON.parse((await readFile(manifestPath, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return ["Manifesto do runtime ausente ou com JSON inválido."];
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    return ["Manifesto do runtime com formato inválido."];
  const record = manifest as Record<string, unknown>;
  if (record.processes !== isolationPolicy.processes)
    return [
      "Runtime sem a política de processos restritos. Execute scripts/package-project-context.ps1.",
    ];
  if (record.network !== isolationPolicy.network)
    return [
      "Runtime sem bloqueio de rede AppContainer. Execute scripts/package-project-context.ps1.",
    ];
  if (
    record.contract !== WORKER_CONTRACT ||
    record.adapter !== ADAPTER_VERSION ||
    record.isolation !== isolationPolicy.mechanism ||
    typeof record.lock !== "string" ||
    !/^[a-f0-9]{64}$/i.test(record.lock) ||
    !record.python ||
    typeof record.python !== "object" ||
    Array.isArray(record.python)
  )
    return ["Manifesto do runtime não corresponde ao contrato esperado."];
  const python = record.python as Record<string, unknown>;
  if (
    typeof python.version !== "string" ||
    typeof python.executable !== "string" ||
    typeof python.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(python.sha256)
  )
    return ["Metadados do Python ausentes ou inválidos no manifesto."];
  if (
    !Array.isArray(record.files) ||
    record.files.length === 0 ||
    record.files.length > MAX_MANIFEST_FILES
  )
    return ["Lista de arquivos do runtime ausente ou inválida."];

  const entries: RuntimeManifestFile[] = [];
  const seen = new Set<string>();
  for (const value of record.files) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push("Entrada inválida na lista de arquivos do runtime.");
      continue;
    }
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.path !== "string" ||
      !entry.path ||
      entry.path.includes("\\") ||
      entry.path.startsWith("/") ||
      entry.path.split("/").some((part) => !part || part === "." || part === "..") ||
      entry.path.includes(":") ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) ||
      (entry.bytes as number) < 0
    ) {
      errors.push("Caminho, tamanho ou hash inválido no manifesto do runtime.");
      continue;
    }
    const key = entry.path.toLowerCase();
    if (seen.has(key)) {
      errors.push("O manifesto do runtime contém caminhos duplicados.");
      continue;
    }
    seen.add(key);
    entries.push({
      path: entry.path,
      sha256: entry.sha256.toLowerCase(),
      bytes: entry.bytes as number,
    });
  }

  const required = [
    "venv/Scripts/python.exe",
    "worker/lowil_launcher.py",
    "worker/worker.py",
  ];
  for (const requiredPath of required)
    if (!seen.has(requiredPath.toLowerCase()))
      errors.push(`Arquivo obrigatório ausente no manifesto: ${requiredPath}.`);

  for (const entry of entries) {
    const parts = entry.path.split("/");
    let current = root;
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index]);
      if (!isInside(current, root)) {
        errors.push(`Caminho do runtime escapa da pasta permitida: ${entry.path}.`);
        break;
      }
      let info;
      try {
        info = await lstat(current);
      } catch {
        errors.push(`Arquivo listado no manifesto está ausente: ${entry.path}.`);
        break;
      }
      if (info.isSymbolicLink()) {
        errors.push(`Redirecionamento recusado no runtime: ${entry.path}.`);
        break;
      }
      if (index < parts.length - 1 && !info.isDirectory()) {
        errors.push(`Pasta inválida no caminho do runtime: ${entry.path}.`);
        break;
      }
      if (index === parts.length - 1) {
        if (!info.isFile() || info.size !== entry.bytes) {
          errors.push(`Tamanho ou tipo de arquivo diverge do manifesto: ${entry.path}.`);
          break;
        }
        try {
          const digest = createHash("sha256")
            .update(await readFile(current))
            .digest("hex");
          if (digest !== entry.sha256)
            errors.push(`Hash do runtime diverge do manifesto: ${entry.path}.`);
        } catch {
          errors.push(`Não foi possível verificar o arquivo do runtime: ${entry.path}.`);
        }
      }
    }
  }
  return [...new Set(errors)];
}

export async function checkIsolation(
  env: SandboxEnvironment,
): Promise<IsolationStatus> {
  const reasons: string[] = [];
  if (env.platform !== "win32")
    reasons.push("O isolamento por integridade baixa depende do Windows.");
  const paths = runtimePaths(env.runtimeDirectory);
  const runtime = await runtimeSha256(env.runtimeDirectory);
  if (!runtime)
    reasons.push(
      "Runtime do worker não foi preparado (execute scripts/package-project-context.ps1).",
    );
  else {
    const integrityErrors = await verifyRuntimeFiles(env.runtimeDirectory);
    if (integrityErrors.length)
      return {
        state: "blocked",
        reasons: [
          "A integridade do runtime não confere com o manifesto:",
          ...integrityErrors,
        ],
        runtimeSha256: runtime,
      };
    for (const [label, path] of [
      ["Python do runtime", paths.python],
      ["lançador", paths.launcher],
      ["worker", paths.worker],
    ] as const)
      if (!(await exists(path)))
        reasons.push(`Arquivo do runtime ausente: ${label}.`);
  }
  for (const directory of [env.runtimeDirectory, env.lowDirectory]) {
    try {
      await assertSafeExternalPath(directory, env.protectedRoot);
    } catch (error) {
      reasons.push(String((error as Error).message));
    }
  }
  if (reasons.length)
    return { state: "unavailable", reasons, runtimeSha256: runtime };
  const approval = await readGateApproval(env.featureDirectory);
  if (!approval)
    return {
      state: "blocked",
      reasons: [
        "A suíte de isolamento (Gate 0) ainda não aprovou esta configuração.",
      ],
      runtimeSha256: runtime,
    };
  if (
    approval.runtimeSha256 !== runtime ||
    approval.adapterVersion !== ADAPTER_VERSION ||
    approval.policySha256 !== POLICY_SHA256 ||
    approval.suiteVersion !== GATE_SUITE_VERSION
  ) {
    return {
      state: "blocked",
      reasons: [
        "Runtime, adaptador ou política mudaram desde a aprovação do Gate 0; é preciso aprovar novamente.",
      ],
      runtimeSha256: runtime,
    };
  }
  if (!env.realSourcesEnabled())
    return {
      state: "disabled",
      reasons: [
        "Gate 0 aprovado. A leitura dos projetos reais está desligada até você ativá-la.",
      ],
      runtimeSha256: runtime,
    };
  return { state: "ready", reasons: [], runtimeSha256: runtime };
}

export async function readGateApproval(
  featureDirectory: string,
): Promise<GateApproval | null> {
  try {
    const path = join(featureDirectory, "gate-approval.json");
    const info = await lstat(path);
    if (info.isSymbolicLink() || info.size > MAX_SMALL_FILE_BYTES) return null;
    const parsed = JSON.parse(
      (await readFile(path, "utf8")).replace(/^\uFEFF/, ""),
    ) as GateApproval;
    return typeof parsed.runtimeSha256 === "string" &&
      typeof parsed.policySha256 === "string" &&
      typeof parsed.adapterVersion === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export async function readWorkerFile(
  exchange: string,
  name: string,
  expected: { jobId: string; seq: number },
): Promise<Record<string, unknown>> {
  if (!WORKER_FILE.test(name))
    throw new IsolationError(`Arquivo de intercâmbio não permitido: ${name}.`);
  const path = join(exchange, name);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile())
    throw new IsolationError(
      "Arquivo de intercâmbio não é um arquivo regular.",
    );
  const max =
    name === "heartbeat.json" || name === "status.json"
      ? MAX_SMALL_FILE_BYTES
      : MAX_WORKER_FILE_BYTES;
  if (info.size > max)
    throw new IsolationError("Arquivo de intercâmbio excede o limite.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new IsolationError("Arquivo de intercâmbio com JSON inválido.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new IsolationError("Arquivo de intercâmbio com formato inválido.");
  const record = parsed as Record<string, unknown>;
  if (
    record.contract !== WORKER_CONTRACT ||
    record.jobId !== expected.jobId ||
    record.seq !== expected.seq
  )
    throw new IsolationError("Mensagem de outro job ou versão descartada.");
  return record;
}

export function workerCommand(
  env: SandboxEnvironment,
  dirs: { input: string; exchange: string; workdir: string },
) {
  const paths = runtimePaths(env.runtimeDirectory);
  return {
    command: paths.python,
    args: [
      "-I",
      paths.launcher,
      "--python",
      paths.python,
      "--entry",
      paths.worker,
      "--workdir",
      dirs.workdir,
      "--memory-mb",
      String(isolationPolicy.job.memoryMb),
      "--max-processes",
      String(isolationPolicy.job.maxProcesses),
      "--read-path",
      dirs.input,
      "--read-path",
      env.sourceRoot,
      "--write-path",
      dirs.exchange,
      "--",
      "--input",
      dirs.input,
      "--exchange",
      dirs.exchange,
      "--source",
      env.sourceRoot,
    ],
  };
}

export class SandboxSupervisor {
  private active: {
    child: ChildProcess;
    inputDir: string;
    jobId: string;
    canceled: boolean;
    exited: boolean;
  } | null = null;

  constructor(private readonly env: SandboxEnvironment) {}

  get busy() {
    return this.active !== null;
  }

  private get inputBase() {
    return join(this.env.featureDirectory, "jobs");
  }
  private get lowBase() {
    return join(this.env.lowDirectory, "jobs");
  }

  async cleanupOrphans(): Promise<void> {
    for (const base of [this.inputBase, this.lowBase]) {
      await assertSafeExternalPath(base, this.env.protectedRoot);
      let names: string[];
      try {
        names = await readdir(base);
      } catch {
        continue;
      }
      for (const name of names.filter((candidate) => JOB_ID.test(candidate)))
        await this.removeJobDir(base, join(base, name));
    }
  }

  private async removeJobDir(base: string, path: string) {
    const absolute = resolve(path);
    if (
      !isInside(absolute, base) ||
      absolute === resolve(base) ||
      isInside(absolute, this.env.protectedRoot)
    )
      throw new IsolationError("Limpeza recusada fora da área de jobs.");
    const info = await lstat(absolute).catch(() => null);
    if (!info) return;
    if (info.isSymbolicLink())
      throw new IsolationError(
        "Limpeza recusada: diretório de job é um redirecionamento.",
      );
    await rm(absolute, { recursive: true, force: true });
  }

  async run(
    op: WorkerOp,
    params: Record<string, unknown>,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: unknown) => void;
    } = {},
  ): Promise<WorkerResult> {
    const status = await checkIsolation(this.env);
    if (status.state !== "ready")
      throw new IsolationError(status.reasons.join(" "));
    if (this.active)
      throw new IsolationError("Já existe uma consulta isolada em andamento.");
    const jobId = `job_${randomBytes(9).toString("base64url")}`;
    const seq = 1;
    const input = join(this.inputBase, jobId, "input");
    const workdir = join(this.lowBase, jobId);
    const exchange = join(workdir, "exchange");
    for (const directory of [input, exchange]) {
      await assertSafeExternalPath(directory, this.env.protectedRoot);
      await mkdir(directory, { recursive: true });
    }
    await writeFile(
      join(input, "request.json"),
      JSON.stringify({ contract: WORKER_CONTRACT, jobId, seq, op, params }),
    );
    const spawn =
      this.env.spawn ??
      ((command, args) =>
        nodeSpawn(command, args, {
          stdio: "ignore",
          windowsHide: true,
          env: { SYSTEMROOT: process.env.SYSTEMROOT ?? "C:\\Windows" },
        }));
    const now = this.env.now ?? Date.now;
    const sleep =
      this.env.sleep ??
      ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
    const { command, args } = workerCommand(this.env, {
      input,
      exchange,
      workdir,
    });
    const child = spawn(command, args);
    const active = {
      child,
      inputDir: input,
      jobId,
      canceled: false,
      exited: false,
    };
    child.once?.("exit", () => {
      active.exited = true;
    });
    this.active = active;
    const abort = () => {
      void this.cancel();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const started = now();
      let lastBeat = started;
      let lastHeartbeatAt: unknown;
      for (;;) {
        if (active.canceled || options.signal?.aborted)
          throw new IsolationError("Consulta cancelada.");
        const beat = await readWorkerFile(exchange, "heartbeat.json", {
          jobId,
          seq,
        }).catch(() => null);
        if (beat && beat.at !== lastHeartbeatAt) {
          lastHeartbeatAt = beat.at;
          lastBeat = now();
          options.onProgress?.(beat.progress);
        }
        const finished = await readWorkerFile(exchange, "status.json", {
          jobId,
          seq,
        }).catch(() => null);
        if (finished) {
          if (finished.state === "failed")
            throw new IsolationError(
              `O worker falhou: ${String(finished.error ?? "erro desconhecido")}.`,
            );
          const response = await readWorkerFile(exchange, "response.json", {
            jobId,
            seq,
          });
          const projectFiles: Record<string, unknown> = {};
          for (const project of Array.isArray(response.projects)
            ? response.projects
            : []) {
            const file = (project as { file?: unknown }).file;
            if (typeof file === "string")
              projectFiles[file] = await readWorkerFile(exchange, file, {
                jobId,
                seq,
              });
          }
          return { response, projectFiles };
        }
        if (active.exited)
          throw new IsolationError(
            "O processo isolado terminou sem publicar resultado.",
          );
        const elapsed = now() - started;
        if (!beat && elapsed > limits.worker.startupMs)
          throw new IsolationError(
            "O worker isolado não iniciou dentro do limite.",
          );
        if (beat && now() - lastBeat > limits.worker.stallMs)
          throw new IsolationError(
            "O worker parou de responder (sem heartbeat).",
          );
        if (elapsed > limits.worker.startupMs + limits.worker.batchMs)
          throw new IsolationError(
            "A consulta excedeu o tempo máximo do lote.",
          );
        await sleep(500);
      }
    } finally {
      options.signal?.removeEventListener("abort", abort);
      await this.stop();
      await this.removeJobDir(
        this.inputBase,
        join(this.inputBase, jobId),
      ).catch(() => undefined);
      await this.removeJobDir(this.lowBase, workdir).catch(() => undefined);
    }
  }

  async cancel(): Promise<void> {
    if (!this.active) return;
    this.active.canceled = true;
    await atomicWrite(
      join(this.active.inputDir, "cancel.json"),
      JSON.stringify({ jobId: this.active.jobId }),
    ).catch(() => undefined);
    await this.stop();
  }

  private async stop() {
    const active = this.active;
    if (!active) return;
    this.active = null;
    if (active.exited || active.child.exitCode !== null) return;
    if (this.env.platform === "win32" && !this.env.spawn && active.child.pid)
      nodeSpawn("taskkill", ["/PID", String(active.child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    else active.child.kill();
  }
}
