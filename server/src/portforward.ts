import { spawn, type ChildProcess } from "node:child_process";
import { kubectlContextArgs } from "./kubeconfig.js";

export type BuiltinPortForwardTarget = "es" | "kibana";

export type PortForwardState = {
  target: string;
  status: "running" | "stopped" | "error";
  namespace: string | null;
  localPort: number;
  service: string;
  pid: number | null;
  message: string | null;
};

type ManagedForward = {
  process: ChildProcess;
  namespace: string;
  localPort: number;
  service: string;
  status: "running" | "error";
  message: string | null;
};

const BUILTIN: Record<
  BuiltinPortForwardTarget,
  { service: string; localPort: number }
> = {
  es: { service: "quickstart-es-http", localPort: 9200 },
  kibana: { service: "quickstart-kb-http", localPort: 5601 },
};

const forwards = new Map<string, ManagedForward>();

function isBuiltin(value: string): value is BuiltinPortForwardTarget {
  return value === "es" || value === "kibana";
}

export function serviceTargetKey(service: string, port: number): string {
  return `svc:${service}:${port}`;
}

export function parseTarget(value: string): string {
  const trimmed = decodeURIComponent(value).trim();
  if (!trimmed) {
    const err = new Error("target is required") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  if (isBuiltin(trimmed) || trimmed.startsWith("svc:")) {
    return trimmed;
  }
  const err = new Error(
    'target must be "es", "kibana", or "svc:<service>:<port>"',
  ) as Error & { statusCode: number };
  err.statusCode = 400;
  throw err;
}

function resolveTarget(target: string): { service: string; localPort: number } {
  if (isBuiltin(target)) {
    return BUILTIN[target];
  }
  const match = /^svc:([^:]+):(\d+)$/.exec(target);
  if (!match) {
    const err = new Error(`invalid service target: ${target}`) as Error & {
      statusCode: number;
    };
    err.statusCode = 400;
    throw err;
  }
  return { service: match[1], localPort: Number(match[2]) };
}

function toState(target: string): PortForwardState {
  const cfg = resolveTarget(target);
  const managed = forwards.get(target);
  if (!managed) {
    return {
      target,
      status: "stopped",
      namespace: null,
      localPort: cfg.localPort,
      service: cfg.service,
      pid: null,
      message: null,
    };
  }
  return {
    target,
    status: managed.status,
    namespace: managed.namespace,
    localPort: managed.localPort,
    service: managed.service,
    pid: managed.process.pid ?? null,
    message: managed.message,
  };
}

export function getPortForwardStatus(): {
  es: PortForwardState;
  kibana: PortForwardState;
  extras: PortForwardState[];
} {
  const extras = [...forwards.keys()]
    .filter((key) => !isBuiltin(key))
    .map((key) => toState(key))
    .sort((a, b) => a.service.localeCompare(b.service) || a.localPort - b.localPort);

  return {
    es: toState("es"),
    kibana: toState("kibana"),
    extras,
  };
}

export function getPortForwardState(target: string): PortForwardState {
  return toState(parseTarget(target));
}

export async function startPortForward(
  target: string,
  namespace: string,
): Promise<PortForwardState> {
  const key = parseTarget(target);
  const existing = forwards.get(key);
  if (existing && existing.status === "running" && !existing.process.killed) {
    if (existing.namespace === namespace) {
      return toState(key);
    }
    await stopPortForward(key);
  }

  const cfg = resolveTarget(key);
  const args = [
    ...kubectlContextArgs(),
    "-n",
    namespace,
    "port-forward",
    `service/${cfg.service}`,
    `${cfg.localPort}:${cfg.localPort}`,
  ];

  const child = spawn("kubectl", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const managed: ManagedForward = {
    process: child,
    namespace,
    localPort: cfg.localPort,
    service: cfg.service,
    status: "running",
    message: null,
  };
  forwards.set(key, managed);

  let settled = false;

  const startup = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve();
      }
    }, 1500);

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      if (/Forwarding from/i.test(text) && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve();
      }
      if (/address already in use|bind:|error forwarding/i.test(text)) {
        managed.status = "error";
        managed.message = text.trim();
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(managed.message));
        }
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("error", (err) => {
      managed.status = "error";
      managed.message = err.message;
      forwards.delete(key);
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    child.on("exit", (code, signal) => {
      const current = forwards.get(key);
      if (current?.process !== child) return;
      if (current.status === "running") {
        current.status = "error";
        current.message =
          code === 0
            ? `port-forward exited (${signal || "ok"})`
            : `port-forward exited with code ${code}${
                current.message ? `: ${current.message}` : ""
              }`;
      }
      forwards.delete(key);
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(current.message || "port-forward failed to start"));
      }
    });
  });

  try {
    await startup;
    if (managed.status === "error") {
      throw new Error(managed.message || "port-forward failed");
    }
    return toState(key);
  } catch (err) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
    forwards.delete(key);
    throw err;
  }
}

export async function stopPortForward(target: string): Promise<PortForwardState> {
  const key = parseTarget(target);
  const managed = forwards.get(key);
  if (!managed) {
    return toState(key);
  }

  await new Promise<void>((resolve) => {
    const child = managed.process;
    const done = () => resolve();
    child.once("exit", done);
    if (child.killed || child.exitCode !== null) {
      done();
      return;
    }
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed && child.exitCode === null) {
        child.kill("SIGKILL");
      }
      done();
    }, 2000);
  });

  forwards.delete(key);
  return toState(key);
}

export async function stopAllPortForwards(): Promise<void> {
  await Promise.all([...forwards.keys()].map((t) => stopPortForward(t)));
}
