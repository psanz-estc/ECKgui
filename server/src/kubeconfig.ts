import * as k8s from "@kubernetes/client-node";

/** In-process kube context override (does not rewrite ~/.kube/config). */
let activeContext: string | null = null;

export function getActiveContextOverride(): string | null {
  return activeContext;
}

export function listKubeContexts(): string[] {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return (kc.getContexts() ?? [])
    .map((c) => c.name)
    .filter((name): name is string => Boolean(name))
    .sort((a, b) => a.localeCompare(b));
}

export function setActiveContext(context: string): string {
  const trimmed = context.trim();
  if (!trimmed) {
    const err = new Error("context is required") as Error & {
      statusCode: number;
    };
    err.statusCode = 400;
    throw err;
  }
  const contexts = listKubeContexts();
  if (!contexts.includes(trimmed)) {
    const err = new Error(
      `Unknown kube context "${trimmed}". Available: ${contexts.join(", ") || "(none)"}`,
    ) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  activeContext = trimmed;
  return trimmed;
}

/** Load kubeconfig and apply the in-process context override when set. */
export function loadKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  if (
    activeContext &&
    kc.getContexts().some((c) => c.name === activeContext)
  ) {
    kc.setCurrentContext(activeContext);
  }
  return kc;
}

/** kubectl --context flag when an override is active. */
export function kubectlContextArgs(): string[] {
  return activeContext ? ["--context", activeContext] : [];
}
