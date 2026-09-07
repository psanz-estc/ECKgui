import * as k8s from "@kubernetes/client-node";
import { loadKubeConfig } from "./kubeconfig.js";

const ES_GROUP = "elasticsearch.k8s.elastic.co";
const KB_GROUP = "kibana.k8s.elastic.co";
const API_VERSION = "v1";
const RESOURCE_NAME = "quickstart";
const MONITOR_NAME = "quickstart-monitor";

export type SidecarMonitorTarget = "self" | "quickstart-monitor";

type CustomApi = {
  getNamespacedCustomObject: (p: Record<string, unknown>) => Promise<unknown>;
  patchNamespacedCustomObject: (p: Record<string, unknown>) => Promise<unknown>;
};

function clients() {
  const kc = loadKubeConfig();
  return {
    custom: kc.makeApiClient(k8s.CustomObjectsApi) as unknown as CustomApi,
  };
}

function getStatusCode(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null) {
    const maybe = err as {
      response?: { statusCode?: number; status?: number };
      statusCode?: number;
      code?: number;
    };
    return (
      maybe.response?.statusCode ??
      maybe.response?.status ??
      maybe.statusCode ??
      maybe.code
    );
  }
  return undefined;
}

function isNotFound(err: unknown): boolean {
  return getStatusCode(err) === 404;
}

function httpError(message: string, statusCode: number): Error & {
  statusCode: number;
} {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function monitoringSpec(refName: string): Record<string, unknown> {
  const refs = { elasticsearchRefs: [{ name: refName }] };
  return { metrics: refs, logs: refs };
}

function refNameFromTarget(target: SidecarMonitorTarget): string {
  return target === "quickstart-monitor" ? MONITOR_NAME : RESOURCE_NAME;
}

async function getCustom(
  custom: CustomApi,
  params: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
    name: string;
  },
): Promise<Record<string, unknown> | null> {
  try {
    return (await custom.getNamespacedCustomObject(params)) as Record<
      string,
      unknown
    >;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

function currentMonitoring(
  obj: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  const spec = asRecord(obj?.spec);
  const monitoring = asRecord(spec?.monitoring);
  return monitoring ?? undefined;
}

function refsFrom(section: unknown): unknown[] {
  const rec = asRecord(section);
  return Array.isArray(rec?.elasticsearchRefs) ? rec.elasticsearchRefs : [];
}

function firstRefName(monitoring?: Record<string, unknown>): string | undefined {
  const refs = [
    ...refsFrom(monitoring?.metrics),
    ...refsFrom(monitoring?.logs),
  ];
  if (refs.length === 0) return undefined;
  const first = asRecord(refs[0]);
  return typeof first?.name === "string" ? first.name : undefined;
}

function hasMonitoringRefs(
  monitoring?: Record<string, unknown>,
): boolean {
  return Boolean(firstRefName(monitoring));
}

async function patchMonitoring(
  custom: CustomApi,
  params: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
    name: string;
    missingMessage: string;
    value: Record<string, unknown> | null;
  },
): Promise<void> {
  const current = await getCustom(custom, {
    group: params.group,
    version: params.version,
    namespace: params.namespace,
    plural: params.plural,
    name: params.name,
  });
  if (!current) {
    throw httpError(params.missingMessage, 404);
  }

  const existing = asRecord(asRecord(current.spec)?.monitoring);
  const hasMonitoringKey = existing !== null;
  if (params.value === null) {
    if (!hasMonitoringRefs(existing ?? undefined)) return;
    await custom.patchNamespacedCustomObject({
      group: params.group,
      version: params.version,
      namespace: params.namespace,
      plural: params.plural,
      name: params.name,
      body: [{ op: "remove", path: "/spec/monitoring" }],
    });
    return;
  }

  await custom.patchNamespacedCustomObject({
    group: params.group,
    version: params.version,
    namespace: params.namespace,
    plural: params.plural,
    name: params.name,
    body: [
      {
        op: hasMonitoringKey ? "replace" : "add",
        path: "/spec/monitoring",
        value: params.value,
      },
    ],
  });
}

export type SidecarMonitoringStatus = {
  enabled: boolean;
  target?: SidecarMonitorTarget;
  refName?: string;
  elasticsearch: boolean;
  kibana: boolean;
};

export async function getSidecarMonitoring(
  namespace: string,
): Promise<SidecarMonitoringStatus> {
  const { custom } = clients();
  const es = await getCustom(custom, {
    group: ES_GROUP,
    version: API_VERSION,
    namespace,
    plural: "elasticsearches",
    name: RESOURCE_NAME,
  });
  const kb = await getCustom(custom, {
    group: KB_GROUP,
    version: API_VERSION,
    namespace,
    plural: "kibanas",
    name: RESOURCE_NAME,
  });
  const esMon = currentMonitoring(es);
  const kbMon = currentMonitoring(kb);
  const refName = firstRefName(esMon) ?? firstRefName(kbMon);
  const enabled = hasMonitoringRefs(esMon) || hasMonitoringRefs(kbMon);
  const target: SidecarMonitorTarget | undefined = !enabled
    ? undefined
    : refName === MONITOR_NAME
      ? "quickstart-monitor"
      : "self";

  return {
    enabled,
    target,
    refName,
    elasticsearch: hasMonitoringRefs(esMon),
    kibana: hasMonitoringRefs(kbMon),
  };
}

export async function applySidecarMonitoring(
  namespace: string,
  target: SidecarMonitorTarget,
): Promise<SidecarMonitoringStatus> {
  const { custom } = clients();
  const refName = refNameFromTarget(target);

  if (target === "quickstart-monitor") {
    const monitor = await getCustom(custom, {
      group: ES_GROUP,
      version: API_VERSION,
      namespace,
      plural: "elasticsearches",
      name: MONITOR_NAME,
    });
    if (!monitor) {
      throw httpError(
        `Elasticsearch "${MONITOR_NAME}" not found in namespace "${namespace}". Deploy that cluster first, or use target "self".`,
        404,
      );
    }
  }

  const value = monitoringSpec(refName);
  await patchMonitoring(custom, {
    group: ES_GROUP,
    version: API_VERSION,
    namespace,
    plural: "elasticsearches",
    name: RESOURCE_NAME,
    missingMessage: `elasticsearches "${RESOURCE_NAME}" not found in namespace "${namespace}". Deploy it first.`,
    value,
  });

  const kb = await getCustom(custom, {
    group: KB_GROUP,
    version: API_VERSION,
    namespace,
    plural: "kibanas",
    name: RESOURCE_NAME,
  });
  if (kb) {
    await patchMonitoring(custom, {
      group: KB_GROUP,
      version: API_VERSION,
      namespace,
      plural: "kibanas",
      name: RESOURCE_NAME,
      missingMessage: `kibanas "${RESOURCE_NAME}" not found in namespace "${namespace}".`,
      value,
    });
  }

  return getSidecarMonitoring(namespace);
}

export async function deleteSidecarMonitoring(
  namespace: string,
): Promise<void> {
  const { custom } = clients();
  const es = await getCustom(custom, {
    group: ES_GROUP,
    version: API_VERSION,
    namespace,
    plural: "elasticsearches",
    name: RESOURCE_NAME,
  });
  if (es) {
    await patchMonitoring(custom, {
      group: ES_GROUP,
      version: API_VERSION,
      namespace,
      plural: "elasticsearches",
      name: RESOURCE_NAME,
      missingMessage: `elasticsearches "${RESOURCE_NAME}" not found in namespace "${namespace}".`,
      value: null,
    });
  }

  const kb = await getCustom(custom, {
    group: KB_GROUP,
    version: API_VERSION,
    namespace,
    plural: "kibanas",
    name: RESOURCE_NAME,
  });
  if (kb) {
    await patchMonitoring(custom, {
      group: KB_GROUP,
      version: API_VERSION,
      namespace,
      plural: "kibanas",
      name: RESOURCE_NAME,
      missingMessage: `kibanas "${RESOURCE_NAME}" not found in namespace "${namespace}".`,
      value: null,
    });
  }
}

export function sidecarTargetFromBody(body: unknown): SidecarMonitorTarget {
  if (typeof body !== "object" || body === null) return "self";
  const raw = (body as { target?: unknown }).target;
  if (raw == null || raw === "") return "self";
  if (raw === "self" || raw === "quickstart-monitor") return raw;
  throw httpError(
    'Invalid target. Use "self" or "quickstart-monitor".',
    400,
  );
}
