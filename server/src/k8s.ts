import * as k8s from "@kubernetes/client-node";
import {
  listKubeContexts,
  loadKubeConfig,
  setActiveContext,
} from "./kubeconfig.js";

const ES_GROUP = "elasticsearch.k8s.elastic.co";
const KB_GROUP = "kibana.k8s.elastic.co";
const LS_GROUP = "logstash.k8s.elastic.co";
const API_VERSION = "v1";
const LS_API_VERSION = "v1alpha1";
const RESOURCE_NAME = "quickstart";

export type ClusterInfo = {
  context: string;
  contexts: string[];
  server: string;
  namespaces: string[];
};

export type PodInfo = {
  name: string;
  phase: string;
  ready: string;
  restarts: number;
};

export type ServicePortInfo = {
  name: string;
  port: number;
  targetPort?: string | number;
  nodePort?: number;
  protocol: string;
  /** Port-forward target key: svc:<service>:<port> */
  forwardTarget: string;
  command: string;
};

export type ServiceInfo = {
  name: string;
  type: string;
  clusterIP?: string;
  ports: ServicePortInfo[];
};

export type ResourceStatus = {
  name: string;
  exists: boolean;
  version?: string;
  health?: string;
  phase?: string;
  nodes?: number;
  count?: number;
  pods: PodInfo[];
  configString?: string | null;
  services?: ServiceInfo[];
};

type CustomApi = {
  createNamespacedCustomObject: (p: Record<string, unknown>) => Promise<unknown>;
  replaceNamespacedCustomObject: (p: Record<string, unknown>) => Promise<unknown>;
  deleteNamespacedCustomObject: (p: Record<string, unknown>) => Promise<unknown>;
  getNamespacedCustomObject: (p: Record<string, unknown>) => Promise<unknown>;
};

type CoreApi = {
  listNamespace: () => Promise<{ items?: k8s.V1Namespace[] }>;
  createNamespace: (p: { body: k8s.V1Namespace }) => Promise<k8s.V1Namespace>;
  deleteNamespace: (p: { name: string }) => Promise<unknown>;
  listNamespacedPod: (p: {
    namespace: string;
    labelSelector?: string;
  }) => Promise<{ items?: k8s.V1Pod[] }>;
  listNamespacedService: (p: {
    namespace: string;
    labelSelector?: string;
  }) => Promise<{ items?: k8s.V1Service[] }>;
  readNamespacedSecret: (p: {
    name: string;
    namespace: string;
  }) => Promise<k8s.V1Secret>;
  readNamespacedPodLog: (p: {
    name: string;
    namespace: string;
    tailLines?: number;
    timestamps?: boolean;
  }) => Promise<string>;
  listNamespacedPersistentVolumeClaim: (p: {
    namespace: string;
  }) => Promise<{ items?: k8s.V1PersistentVolumeClaim[] }>;
  deleteNamespacedPersistentVolumeClaim: (p: {
    name: string;
    namespace: string;
  }) => Promise<unknown>;
};

const HEAP_SIZE_RE = /^(\d+(?:\.\d+)?)([mMgG])$/;

const PROTECTED_NAMESPACES = new Set([
  "default",
  "kube-system",
  "kube-public",
  "kube-node-lease",
  "elastic-system",
]);

const NAMESPACE_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

function clients() {
  const kc = loadKubeConfig();
  return {
    kc,
    core: kc.makeApiClient(k8s.CoreV1Api) as unknown as CoreApi,
    custom: kc.makeApiClient(k8s.CustomObjectsApi) as unknown as CustomApi,
  };
}

function podReady(pod: k8s.V1Pod): string {
  const containers = pod.status?.containerStatuses ?? [];
  if (containers.length === 0) return "0/0";
  const ready = containers.filter((c) => c.ready).length;
  return `${ready}/${containers.length}`;
}

function podRestarts(pod: k8s.V1Pod): number {
  return (pod.status?.containerStatuses ?? []).reduce(
    (sum, c) => sum + (c.restartCount ?? 0),
    0,
  );
}

export async function getClusterInfo(): Promise<ClusterInfo> {
  const { kc, core } = clients();
  const context = kc.getCurrentContext() || "unknown";
  const contexts = listKubeContexts();
  const cluster = kc.getCurrentCluster();
  const nsList = await core.listNamespace();
  const namespaces = (nsList.items ?? [])
    .map((n) => n.metadata?.name)
    .filter((n): n is string => Boolean(n))
    .sort();

  return {
    context,
    contexts: contexts.length > 0 ? contexts : [context],
    server: cluster?.server || "unknown",
    namespaces: namespaces.length > 0 ? namespaces : ["default"],
  };
}

export function switchKubeContext(context: string): string {
  return setActiveContext(context);
}

function assertValidNamespaceName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 63 || !NAMESPACE_NAME_RE.test(trimmed)) {
    const err = new Error(
      "Invalid namespace name. Use lowercase DNS label (a-z, 0-9, -), max 63 chars.",
    ) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  return trimmed;
}

export function isProtectedNamespace(name: string): boolean {
  return PROTECTED_NAMESPACES.has(name);
}

export async function createNamespace(name: string): Promise<string> {
  const ns = assertValidNamespaceName(name);
  const { core } = clients();
  try {
    await core.createNamespace({
      body: {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: ns },
      },
    });
  } catch (err) {
    if (isAlreadyExists(err)) {
      return ns;
    }
    throw err;
  }
  return ns;
}

export async function deleteNamespace(name: string): Promise<void> {
  const ns = assertValidNamespaceName(name);
  if (isProtectedNamespace(ns)) {
    const err = new Error(
      `Namespace "${ns}" is protected and cannot be deleted from ECKgui.`,
    ) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  const { core } = clients();
  try {
    await core.deleteNamespace({ name: ns });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

export function normalizeHeapSize(heapSize?: string | null): string | undefined {
  if (heapSize == null) return undefined;
  const trimmed = heapSize.trim();
  if (!trimmed) return undefined;
  const match = HEAP_SIZE_RE.exec(trimmed);
  if (!match) {
    const err = new Error(
      'Invalid heapSize. Use forms like "512m", "1g", or "2g".',
    ) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  return `${match[1]}${match[2].toLowerCase()}`;
}

/** Container memory ≈ 2× heap (heap ~50% of pod memory). */
function memoryLimitForHeap(heap: string): string {
  const match = HEAP_SIZE_RE.exec(heap);
  if (!match) return "2Gi";
  const value = Number(match[1]) * 2;
  const unit = match[2].toLowerCase() === "m" ? "Mi" : "Gi";
  return `${value % 1 === 0 ? value : value.toFixed(1)}${unit}`;
}

export function normalizeNodeCount(nodeCount?: number | null): number {
  if (nodeCount == null || Number.isNaN(nodeCount)) return 1;
  const n = Math.floor(Number(nodeCount));
  if (!Number.isFinite(n) || n < 1 || n > 9) {
    const err = new Error(
      "nodeCount must be an integer between 1 and 9.",
    ) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  return n;
}

function buildElasticsearchManifest(
  version: string,
  namespace: string,
  options: { heapSize?: string; nodeCount?: number } = {},
) {
  const nodeSet: Record<string, unknown> = {
    name: "default",
    count: normalizeNodeCount(options.nodeCount),
    config: {
      "node.store.allow_mmap": false,
    },
  };

  const heap = normalizeHeapSize(options.heapSize);
  if (heap) {
    const memory = memoryLimitForHeap(heap);
    nodeSet.podTemplate = {
      spec: {
        containers: [
          {
            name: "elasticsearch",
            env: [
              {
                name: "ES_JAVA_OPTS",
                value: `-Xms${heap} -Xmx${heap}`,
              },
            ],
            resources: {
              requests: { memory },
              limits: { memory },
            },
          },
        ],
      },
    };
  }

  return {
    apiVersion: `${ES_GROUP}/${API_VERSION}`,
    kind: "Elasticsearch",
    metadata: { name: RESOURCE_NAME, namespace },
    spec: {
      version,
      // Ensure PVC (and thus PV with Delete reclaim) go away with the cluster.
      volumeClaimDeletePolicy: "DeleteOnScaledownAndClusterDeletion",
      nodeSets: [nodeSet],
    },
  };
}

function buildKibanaManifest(version: string, namespace: string) {
  // Seed Fleet's default ES output before Fleet Server exists. Otherwise
  // Kibana initializes fleet-default-output as localhost:9200 and later
  // xpack.fleet.agents.elasticsearch.hosts changes may not override it.
  return {
    apiVersion: `${KB_GROUP}/${API_VERSION}`,
    kind: "Kibana",
    metadata: { name: RESOURCE_NAME, namespace },
    spec: {
      version,
      count: 1,
      elasticsearchRef: {
        name: RESOURCE_NAME,
      },
      config: {
        "xpack.fleet.agents.elasticsearch.hosts": [
          `https://${RESOURCE_NAME}-es-http.${namespace}.svc:9200`,
        ],
      },
    },
  };
}

function buildLogstashManifest(
  version: string,
  namespace: string,
  configString: string,
) {
  return {
    apiVersion: `${LS_GROUP}/${LS_API_VERSION}`,
    kind: "Logstash",
    metadata: { name: RESOURCE_NAME, namespace },
    spec: {
      count: 1,
      version,
      elasticsearchRefs: [
        {
          name: RESOURCE_NAME,
          clusterName: "qs",
        },
      ],
      pipelines: [
        {
          "pipeline.id": "main",
          "config.string": configString,
        },
      ],
      services: [
        {
          name: "beats",
          service: {
            spec: {
              type: "NodePort",
              ports: [
                {
                  port: 5044,
                  name: "filebeat",
                  protocol: "TCP",
                  targetPort: 5044,
                },
              ],
            },
          },
        },
      ],
    },
  };
}

function extractLogstashConfigString(spec: Record<string, unknown>): string | null {
  const pipelines = spec.pipelines;
  if (!Array.isArray(pipelines) || pipelines.length === 0) return null;
  const main =
    pipelines.find(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        (p as { "pipeline.id"?: string })["pipeline.id"] === "main",
    ) ?? pipelines[0];
  if (typeof main !== "object" || main === null) return null;
  const config = (main as { "config.string"?: unknown })["config.string"];
  return typeof config === "string" ? config : null;
}

export async function deployElasticsearch(
  namespace: string,
  version: string,
  options: { heapSize?: string; nodeCount?: number } = {},
): Promise<void> {
  const { custom } = clients();
  const body = buildElasticsearchManifest(version, namespace, options);
  try {
    await custom.createNamespacedCustomObject({
      group: ES_GROUP,
      version: API_VERSION,
      namespace,
      plural: "elasticsearches",
      body,
    });
  } catch (err) {
    if (isAlreadyExists(err)) {
      const current = (await custom.getNamespacedCustomObject({
        group: ES_GROUP,
        version: API_VERSION,
        namespace,
        plural: "elasticsearches",
        name: RESOURCE_NAME,
      })) as { metadata?: { resourceVersion?: string } };
      await custom.replaceNamespacedCustomObject({
        group: ES_GROUP,
        version: API_VERSION,
        name: RESOURCE_NAME,
        namespace,
        plural: "elasticsearches",
        body: {
          ...body,
          metadata: {
            ...body.metadata,
            resourceVersion: current.metadata?.resourceVersion,
          },
        },
      });
      return;
    }
    throw err;
  }
}

export async function deployKibana(
  namespace: string,
  version: string,
): Promise<void> {
  const { custom } = clients();
  const body = buildKibanaManifest(version, namespace);
  try {
    await custom.createNamespacedCustomObject({
      group: KB_GROUP,
      version: API_VERSION,
      namespace,
      plural: "kibanas",
      body,
    });
  } catch (err) {
    if (isAlreadyExists(err)) {
      const current = (await custom.getNamespacedCustomObject({
        group: KB_GROUP,
        version: API_VERSION,
        namespace,
        plural: "kibanas",
        name: RESOURCE_NAME,
      })) as { metadata?: { resourceVersion?: string } };
      await custom.replaceNamespacedCustomObject({
        group: KB_GROUP,
        version: API_VERSION,
        name: RESOURCE_NAME,
        namespace,
        plural: "kibanas",
        body: {
          ...body,
          metadata: {
            ...body.metadata,
            resourceVersion: current.metadata?.resourceVersion,
          },
        },
      });
      return;
    }
    throw err;
  }
}

export async function deleteElasticsearch(namespace: string): Promise<void> {
  const { custom } = clients();
  try {
    await custom.deleteNamespacedCustomObject({
      group: ES_GROUP,
      version: API_VERSION,
      name: RESOURCE_NAME,
      namespace,
      plural: "elasticsearches",
    });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

export async function deleteKibana(namespace: string): Promise<void> {
  const { custom } = clients();
  try {
    await custom.deleteNamespacedCustomObject({
      group: KB_GROUP,
      version: API_VERSION,
      name: RESOURCE_NAME,
      namespace,
      plural: "kibanas",
    });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

export async function deployLogstash(
  namespace: string,
  version: string,
  configString: string,
): Promise<void> {
  const { custom } = clients();
  const body = buildLogstashManifest(version, namespace, configString);
  try {
    await custom.createNamespacedCustomObject({
      group: LS_GROUP,
      version: LS_API_VERSION,
      namespace,
      plural: "logstashes",
      body,
    });
  } catch (err) {
    if (isAlreadyExists(err)) {
      const current = (await custom.getNamespacedCustomObject({
        group: LS_GROUP,
        version: LS_API_VERSION,
        namespace,
        plural: "logstashes",
        name: RESOURCE_NAME,
      })) as { metadata?: { resourceVersion?: string } };
      await custom.replaceNamespacedCustomObject({
        group: LS_GROUP,
        version: LS_API_VERSION,
        name: RESOURCE_NAME,
        namespace,
        plural: "logstashes",
        body: {
          ...body,
          metadata: {
            ...body.metadata,
            resourceVersion: current.metadata?.resourceVersion,
          },
        },
      });
      return;
    }
    throw err;
  }
}

export async function deleteLogstash(namespace: string): Promise<void> {
  const { custom } = clients();
  try {
    await custom.deleteNamespacedCustomObject({
      group: LS_GROUP,
      version: LS_API_VERSION,
      name: RESOURCE_NAME,
      namespace,
      plural: "logstashes",
    });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

function isQuickstartPvc(pvc: k8s.V1PersistentVolumeClaim): boolean {
  const name = pvc.metadata?.name || "";
  const labels = pvc.metadata?.labels ?? {};
  if (name.includes(RESOURCE_NAME)) return true;
  if (labels["elasticsearch.k8s.elastic.co/cluster-name"] === RESOURCE_NAME) {
    return true;
  }
  if (labels["logstash.k8s.elastic.co/name"] === RESOURCE_NAME) return true;
  if (labels["kibana.k8s.elastic.co/name"] === RESOURCE_NAME) return true;
  return false;
}

/** Best-effort delete of quickstart PVCs left after CR deletion. */
export async function deleteQuickstartPvcs(namespace: string): Promise<void> {
  const { core } = clients();
  const res = await core.listNamespacedPersistentVolumeClaim({ namespace });
  const pvcs = (res.items ?? []).filter(isQuickstartPvc);
  await Promise.all(
    pvcs.map(async (pvc) => {
      const name = pvc.metadata?.name;
      if (!name) return;
      try {
        await core.deleteNamespacedPersistentVolumeClaim({ name, namespace });
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }),
  );
}

/** Delete Logstash, Kibana, then Elasticsearch (dependents first), then PVCs. */
export async function destroyQuickstart(namespace: string): Promise<void> {
  await deleteLogstash(namespace);
  await deleteKibana(namespace);
  await deleteElasticsearch(namespace);
  await deleteQuickstartPvcs(namespace);
}

export async function getElasticsearchStatus(
  namespace: string,
): Promise<ResourceStatus> {
  const { custom, core } = clients();
  try {
    const obj = (await custom.getNamespacedCustomObject({
      group: ES_GROUP,
      version: API_VERSION,
      name: RESOURCE_NAME,
      namespace,
      plural: "elasticsearches",
    })) as Record<string, unknown>;

    const status = (obj.status ?? {}) as Record<string, unknown>;
    const spec = (obj.spec ?? {}) as Record<string, unknown>;
    const pods = await listPods(
      core,
      namespace,
      "elasticsearch.k8s.elastic.co/cluster-name=quickstart",
    );

    return withTerminatingHealth({
      name: RESOURCE_NAME,
      exists: true,
      version: String(spec.version ?? ""),
      health: status.health ? String(status.health) : undefined,
      phase: status.phase ? String(status.phase) : undefined,
      nodes:
        typeof status.availableNodes === "number"
          ? status.availableNodes
          : undefined,
      pods,
    });
  } catch (err) {
    if (isNotFound(err)) {
      const terminating = await statusWhileTerminating(
        core,
        RESOURCE_NAME,
        "elasticsearch.k8s.elastic.co/cluster-name=quickstart",
        namespace,
      );
      return (
        terminating ?? { name: RESOURCE_NAME, exists: false, pods: [] }
      );
    }
    throw err;
  }
}

export async function getKibanaStatus(
  namespace: string,
): Promise<ResourceStatus> {
  const { custom, core } = clients();
  try {
    const obj = (await custom.getNamespacedCustomObject({
      group: KB_GROUP,
      version: API_VERSION,
      name: RESOURCE_NAME,
      namespace,
      plural: "kibanas",
    })) as Record<string, unknown>;

    const status = (obj.status ?? {}) as Record<string, unknown>;
    const spec = (obj.spec ?? {}) as Record<string, unknown>;
    const pods = await listPods(
      core,
      namespace,
      "kibana.k8s.elastic.co/name=quickstart",
    );

    return withTerminatingHealth({
      name: RESOURCE_NAME,
      exists: true,
      version: String(spec.version ?? ""),
      health: status.health ? String(status.health) : undefined,
      count: typeof spec.count === "number" ? spec.count : undefined,
      pods,
    });
  } catch (err) {
    if (isNotFound(err)) {
      const terminating = await statusWhileTerminating(
        core,
        RESOURCE_NAME,
        "kibana.k8s.elastic.co/name=quickstart",
        namespace,
      );
      return (
        terminating ?? { name: RESOURCE_NAME, exists: false, pods: [] }
      );
    }
    throw err;
  }
}

export async function getLogstashStatus(
  namespace: string,
): Promise<ResourceStatus> {
  const { custom, core } = clients();
  try {
    const obj = (await custom.getNamespacedCustomObject({
      group: LS_GROUP,
      version: LS_API_VERSION,
      name: RESOURCE_NAME,
      namespace,
      plural: "logstashes",
    })) as Record<string, unknown>;

    const status = (obj.status ?? {}) as Record<string, unknown>;
    const spec = (obj.spec ?? {}) as Record<string, unknown>;
    const [pods, services] = await Promise.all([
      listPods(core, namespace, "logstash.k8s.elastic.co/name=quickstart"),
      listLogstashServices(core, namespace),
    ]);

    const available =
      typeof status.availableNodes === "number"
        ? status.availableNodes
        : typeof status.available === "number"
          ? status.available
          : undefined;
    const expected =
      typeof status.expectedNodes === "number"
        ? status.expectedNodes
        : typeof spec.count === "number"
          ? spec.count
          : undefined;

    let health: string | undefined;
    if (typeof available === "number" && typeof expected === "number") {
      health =
        available >= expected && expected > 0
          ? "green"
          : available > 0
            ? "yellow"
            : "red";
    } else if (pods.some((p) => p.phase === "Running" && p.ready.startsWith("1/"))) {
      health = "green";
    }

    return withTerminatingHealth({
      name: RESOURCE_NAME,
      exists: true,
      version: String(spec.version ?? ""),
      health,
      count: typeof spec.count === "number" ? spec.count : undefined,
      nodes: available,
      configString: extractLogstashConfigString(spec),
      pods,
      services,
    });
  } catch (err) {
    if (isNotFound(err)) {
      const terminating = await statusWhileTerminating(
        core,
        RESOURCE_NAME,
        "logstash.k8s.elastic.co/name=quickstart",
        namespace,
        { configString: null, services: [] },
      );
      return (
        terminating ?? {
          name: RESOURCE_NAME,
          exists: false,
          pods: [],
          configString: null,
          services: [],
        }
      );
    }
    throw err;
  }
}

export async function getCredentials(namespace: string): Promise<{
  user: string;
  password: string | null;
  portForwardEs: string;
  portForwardKibana: string;
}> {
  const { core } = clients();
  let password: string | null = null;
  try {
    const secret = await core.readNamespacedSecret({
      name: "quickstart-es-elastic-user",
      namespace,
    });
    const encoded = secret.data?.elastic;
    if (encoded) {
      password = Buffer.from(encoded, "base64").toString("utf8");
    }
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  return {
    user: "elastic",
    password,
    portForwardEs: `kubectl -n ${namespace} port-forward service/quickstart-es-http 9200`,
    portForwardKibana: `kubectl -n ${namespace} port-forward service/quickstart-kb-http 5601`,
  };
}

function podPhase(pod: k8s.V1Pod): string {
  if (pod.metadata?.deletionTimestamp) return "Terminating";
  return pod.status?.phase || "Unknown";
}

function withTerminatingHealth(
  status: ResourceStatus,
): ResourceStatus {
  if (
    status.pods.length > 0 &&
    status.pods.every((p) => p.phase === "Terminating")
  ) {
    return { ...status, health: "terminating", phase: "Terminating" };
  }
  return status;
}

async function listPods(
  core: CoreApi,
  namespace: string,
  labelSelector: string,
): Promise<PodInfo[]> {
  const res = await core.listNamespacedPod({
    namespace,
    labelSelector,
  });
  return (res.items ?? []).map((pod) => ({
    name: pod.metadata?.name || "unknown",
    phase: podPhase(pod),
    ready: podReady(pod),
    restarts: podRestarts(pod),
  }));
}

/** Keep showing a resource while pods are still Terminating after the CR is gone. */
async function statusWhileTerminating(
  core: CoreApi,
  name: string,
  labelSelector: string,
  namespace: string,
  extras: Partial<ResourceStatus> = {},
): Promise<ResourceStatus | null> {
  const pods = await listPods(core, namespace, labelSelector);
  if (pods.length === 0) return null;
  return {
    name,
    exists: true,
    health: "terminating",
    phase: "Terminating",
    pods,
    ...extras,
  };
}

/** Same as statusWhileTerminating, but loads the kube client itself (for fleet.ts). */
export async function statusWhileTerminatingPods(
  name: string,
  labelSelector: string,
  namespace: string,
  extras: Partial<ResourceStatus> = {},
): Promise<ResourceStatus | null> {
  const { core } = clients();
  return statusWhileTerminating(core, name, labelSelector, namespace, extras);
}

async function listLogstashServices(
  core: CoreApi,
  namespace: string,
): Promise<ServiceInfo[]> {
  const res = await core.listNamespacedService({
    namespace,
    labelSelector: "logstash.k8s.elastic.co/name=quickstart",
  });

  return (res.items ?? [])
    .map((svc) => {
      const name = svc.metadata?.name || "unknown";
      const type = svc.spec?.type || "ClusterIP";
      const ports = (svc.spec?.ports ?? [])
        .filter((p): p is k8s.V1ServicePort & { port: number } => typeof p.port === "number")
        .map((p) => {
          const port = p.port;
          return {
            name: p.name || String(port),
            port,
            targetPort:
              typeof p.targetPort === "object" && p.targetPort !== null
                ? undefined
                : (p.targetPort as string | number | undefined),
            nodePort: typeof p.nodePort === "number" ? p.nodePort : undefined,
            protocol: p.protocol || "TCP",
            forwardTarget: `svc:${name}:${port}`,
            command: `kubectl -n ${namespace} port-forward service/${name} ${port}:${port}`,
          };
        });

      return {
        name,
        type,
        clusterIP: svc.spec?.clusterIP,
        ports,
      };
    })
    .filter((svc) => svc.ports.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function isAlreadyExists(err: unknown): boolean {
  return getStatusCode(err) === 409;
}

function isNotFound(err: unknown): boolean {
  return getStatusCode(err) === 404;
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

export function getErrorMessage(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const maybe = err as {
      body?: { message?: string };
      message?: string;
      response?: { body?: { message?: string } };
    };
    return (
      maybe.body?.message ||
      maybe.response?.body?.message ||
      maybe.message ||
      "Unknown Kubernetes error"
    );
  }
  return String(err);
}

export async function getPodLogs(
  namespace: string,
  name: string,
  tailLines = 200,
): Promise<{
  name: string;
  namespace: string;
  tailLines: number;
  logs: string;
}> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    const err = new Error("pod name is required") as Error & {
      statusCode: number;
    };
    err.statusCode = 400;
    throw err;
  }
  const lines = Math.min(5000, Math.max(1, Math.floor(tailLines) || 200));
  const { core } = clients();
  try {
    const logs = await core.readNamespacedPodLog({
      name: trimmedName,
      namespace,
      tailLines: lines,
      timestamps: true,
    });
    return {
      name: trimmedName,
      namespace,
      tailLines: lines,
      logs: typeof logs === "string" ? logs : String(logs ?? ""),
    };
  } catch (err) {
    if (isNotFound(err)) {
      const notFound = new Error(
        `Pod "${trimmedName}" not found in namespace "${namespace}".`,
      ) as Error & { statusCode: number };
      notFound.statusCode = 404;
      throw notFound;
    }
    throw err;
  }
}
