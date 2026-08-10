import { spawn, type ChildProcess } from "node:child_process";

export type PortForwardTarget = "es" | "kibana";

export type PortForwardState = {
  target: PortForwardTarget;
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

const TARGETS: Record<
  PortForwardTarget,
  { service: string; localPort: number }
> = {
  es: { service: "quickstart-es-http", localPort: 9200 },
  kibana: { service: "quickstart-kb-http", localPort: 5601 },
};

const forwards = new Map<PortForwardTarget, ManagedForward>();

function isTarget(value: string): value is PortForwardTarget {
  return value === "es" || value === "kibana";
}

export function parseTarget(value: string): PortForwardTarget {
  if (!isTarget(value)) {
    const err = new Error('target must be "es" or "kibana"') as Error & {
      statusCode: number;
    };
    err.statusCode = 400;
    throw err;
  }
  return value;
}

function toState(target: PortForwardTarget): PortForwardState {
  const cfg = TARGETS[target];
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
} {
  return {
    es: toState("es"),
    kibana: toState("kibana"),
  };
}

export async function startPortForward(
  target: PortForwardTarget,
  namespace: string,
): Promise<PortForwardState> {
  const existing = forwards.get(target);
  if (existing && existing.status === "running" && !existing.process.killed) {
    if (existing.namespace === namespace) {
      return toState(target);
    }
    await stopPortForward(target);
  }

  const cfg = TARGETS[target];
  const args = [
    "-n",
    namespace,
    "port-forward",
    `service/${cfg.service}`,
    String(cfg.localPort),
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
  forwards.set(target, managed);

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
      forwards.delete(target);
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    child.on("exit", (code, signal) => {
      const current = forwards.get(target);
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
      forwards.delete(target);
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
    return toState(target);
  } catch (err) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
    forwards.delete(target);
    throw err;
  }
}

export async function stopPortForward(
  target: PortForwardTarget,
): Promise<PortForwardState> {
  const managed = forwards.get(target);
  if (!managed) {
    return toState(target);
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

  forwards.delete(target);
  return toState(target);
}

export async function stopAllPortForwards(): Promise<void> {
  await Promise.all(
    (["es", "kibana"] as PortForwardTarget[]).map((t) => stopPortForward(t)),
  );
}
