import { spawn } from "node:child_process";
import * as k8s from "@kubernetes/client-node";
import {
  compareVersions,
  emptyEckOperatorStatus,
  getEckOperatorStatus,
  type EckOperatorStatus,
} from "./eck.js";
import {
  listKubeContexts,
  loadKubeConfig,
  kubectlContextArgs,
  setActiveContext,
} from "./kubeconfig.js";

const ES_GROUP = "elasticsearch.k8s.elastic.co";
const KB_GROUP = "kibana.k8s.elastic.co";
const LS_GROUP = "logstash.k8s.elastic.co";
const API_VERSION = "v1";
const LS_API_VERSION = "v1alpha1";
const RESOURCE_NAME = "quickstart";

export type ClusterMemory = {
  allocatableBytes: number;
  requestBytes: number;
  remainingBytes: number;
  percent: number;
  nodeCount: number;
};

export type ClusterInfo = {
  context: string;
  contexts: string[];
  server: string;
  namespaces: string[];
  reachable: boolean;
  eckInstalled: boolean;
  eck: EckOperatorStatus;
  memory?: ClusterMemory;
  error?: string;
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
  heapSize?: string;
  pods: PodInfo[];
  configString?: string | null;
  services?: ServiceInfo[];
};

type CustomApi = {
  createNamespacedCustomObject: (p: Record<string, unknown>) => Promise<unknown>;
  replaceNamespacedCustomObject: (p: Record<string, unknown>) => Promise<unknown>;
  patchNamespacedCustomObject: (p: Record<string, unknown>) => Promise<unknown>;
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
  createNamespacedSecret: (p: {
    namespace: string;
    body: k8s.V1Secret;
  }) => Promise<k8s.V1Secret>;
  listNamespacedSecret: (p: {
    namespace: string;
    labelSelector?: string;
  }) => Promise<{ items?: k8s.V1Secret[] }>;
  readNamespacedConfigMap: (p: {
    name: string;
    namespace: string;
  }) => Promise<k8s.V1ConfigMap>;
  readNamespacedPodLog: (p: {
    name: string;
    namespace: string;
    tailLines?: number;
    timestamps?: boolean;
  }) => Promise<string>;
  listNode: () => Promise<{ items?: k8s.V1Node[] }>;
  listPodForAllNamespaces: () => Promise<{ items?: k8s.V1Pod[] }>;
  listNamespacedPersistentVolumeClaim: (p: {
    namespace: string;
  }) => Promise<{ items?: k8s.V1PersistentVolumeClaim[] }>;
  deleteNamespacedPersistentVolumeClaim: (p: {
    name: string;
    namespace: string;
  }) => Promise<unknown>;
  deleteNamespacedPod: (p: {
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

const MEMORY_SUFFIX: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};

export function parseQuantityToBytes(quantity?: string): number {
  if (!quantity) return 0;
  const match = /^([0-9]+(?:\.[0-9]+)?)([eE][+-]?[0-9]+)?([a-zA-Z]+)?$/.exec(
    quantity.trim(),
  );
  if (!match) return 0;
  let value = Number(`${match[1]}${match[2] ?? ""}`);
  if (!Number.isFinite(value)) return 0;
  const suffix = match[3] ?? "";
  if (suffix) {
    const factor = MEMORY_SUFFIX[suffix];
    if (factor == null) return 0;
    value *= factor;
  }
  return Math.max(0, Math.round(value));
}

function containerMemoryRequests(
  containers: k8s.V1Container[] | undefined,
): number {
  return (containers ?? []).reduce((sum, container) => {
    return sum + parseQuantityToBytes(container.resources?.requests?.memory);
  }, 0);
}

function podMemoryRequestBytes(pod: k8s.V1Pod): number {
  const phase = pod.status?.phase;
  if (phase === "Succeeded" || phase === "Failed") return 0;
  return (
    containerMemoryRequests(pod.spec?.initContainers) +
    containerMemoryRequests(pod.spec?.containers) +
    parseQuantityToBytes(pod.spec?.overhead?.memory)
  );
}

export async function getClusterMemory(): Promise<ClusterMemory> {
  const { core } = clients();
  const [nodes, pods] = await Promise.all([
    core.listNode(),
    core.listPodForAllNamespaces(),
  ]);
  const nodeItems = nodes.items ?? [];
  const allocatableBytes = nodeItems.reduce((sum, node) => {
    return sum + parseQuantityToBytes(node.status?.allocatable?.memory);
  }, 0);
  const requestBytes = (pods.items ?? []).reduce((sum, pod) => {
    return sum + podMemoryRequestBytes(pod);
  }, 0);
  const remainingBytes = Math.max(0, allocatableBytes - requestBytes);
  const percent =
    allocatableBytes > 0
      ? Math.min(100, (requestBytes / allocatableBytes) * 100)
      : 0;
  return {
    allocatableBytes,
    requestBytes,
    remainingBytes,
    percent: Math.round(percent * 10) / 10,
    nodeCount: nodeItems.length,
  };
}

export async function watchClusterMemory(
  onUpdate: (memory: ClusterMemory) => void,
  signal: AbortSignal,
): Promise<void> {
  const kc = loadKubeConfig();
  const watch = new k8s.Watch(kc);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      getClusterMemory()
        .then(onUpdate)
        .catch(() => undefined);
    }, 200);
  };
  const controller = await watch.watch(
    "/api/v1/pods",
    {},
    (phase) => {
      if (phase === "ADDED" || phase === "MODIFIED" || phase === "DELETED") {
        schedule();
      }
    },
    () => undefined,
  );
  const abort = () => {
    if (timer) clearTimeout(timer);
    controller.abort();
  };
  if (signal.aborted) {
    abort();
    return;
  }
  signal.addEventListener("abort", abort, { once: true });
}

export async function getClusterInfo(): Promise<ClusterInfo> {
  let context = "unknown";
  let contexts: string[] = [];
  let server = "unknown";

  try {
    const { kc } = clients();
    context = kc.getCurrentContext() || "unknown";
    contexts = listKubeContexts();
    server = kc.getCurrentCluster()?.server || "unknown";
  } catch (err) {
    return {
      context,
      contexts: contexts.length > 0 ? contexts : [context],
      server,
      namespaces: ["default"],
      reachable: false,
      eckInstalled: false,
      eck: emptyEckOperatorStatus(),
      error: getErrorMessage(err),
    };
  }

  try {
    const { core } = clients();
    const nsList = await core.listNamespace();
    const namespaces = (nsList.items ?? [])
      .map((n) => n.metadata?.name)
      .filter((n): n is string => Boolean(n))
      .sort();

    const eck = await getEckOperatorStatus();
    let memory: ClusterMemory | undefined;
    try {
      memory = await getClusterMemory();
    } catch {
      memory = undefined;
    }

    return {
      context,
      contexts: contexts.length > 0 ? contexts : [context],
      server,
      namespaces: namespaces.length > 0 ? namespaces : ["default"],
      reachable: true,
      eckInstalled: eck.installed,
      eck,
      memory,
    };
  } catch (err) {
    return {
      context,
      contexts: contexts.length > 0 ? contexts : [context],
      server,
      namespaces: ["default"],
      reachable: false,
      eckInstalled: false,
      eck: emptyEckOperatorStatus(),
      error: getErrorMessage(err),
    };
  }
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
      `Namespace "${ns}" is protected and cannot be deleted from YAEU.`,
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

const JAVA_HEAP_RE = /-Xm[sx](\d+(?:\.\d+)?[mMgG])/i;

function elasticsearchHeapContainer(heap: string): Record<string, unknown> {
  const memory = memoryLimitForHeap(heap);
  return {
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
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nodeSetsFromSpec(spec: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(spec.nodeSets)) return [];
  return spec.nodeSets
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null);
}

function defaultNodeSetIndex(nodeSets: Record<string, unknown>[]): number {
  const named = nodeSets.findIndex((ns) => ns.name === "default");
  return named >= 0 ? named : 0;
}

function extractHeapSizeFromNodeSet(
  nodeSet: Record<string, unknown> | undefined,
): string | undefined {
  const podTemplate = asRecord(nodeSet?.podTemplate);
  const spec = asRecord(podTemplate?.spec);
  const containers = spec?.containers;
  if (!Array.isArray(containers)) return undefined;
  const esContainer =
    containers.find((c) => asRecord(c)?.name === "elasticsearch") ??
    containers[0];
  const env = asRecord(esContainer)?.env;
  if (!Array.isArray(env)) return undefined;
  const javaOpts = env.find((entry) => asRecord(entry)?.name === "ES_JAVA_OPTS");
  const value = asRecord(javaOpts)?.value;
  if (typeof value !== "string") return undefined;
  const match = JAVA_HEAP_RE.exec(value);
  if (!match) return undefined;
  try {
    return normalizeHeapSize(match[1]);
  } catch {
    return undefined;
  }
}

function applyHeapToNodeSet(
  nodeSet: Record<string, unknown>,
  heap: string | undefined,
): Record<string, unknown> {
  const next = { ...nodeSet };
  if (!heap) {
    delete next.podTemplate;
    return next;
  }
  const existingPt = asRecord(nodeSet.podTemplate) ?? {};
  const existingSpec = asRecord(existingPt.spec) ?? {};
  const containers = Array.isArray(existingSpec.containers)
    ? existingSpec.containers.map((c) => asRecord(c)).filter((c) => c !== null)
    : [];
  const heapContainer = elasticsearchHeapContainer(heap);
  const idx = containers.findIndex((c) => c.name === "elasticsearch");
  if (idx >= 0) {
    containers[idx] = { ...containers[idx], ...heapContainer };
  } else {
    containers.push(heapContainer);
  }
  next.podTemplate = {
    ...existingPt,
    spec: {
      ...existingSpec,
      containers,
    },
  };
  return next;
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
    nodeSet.podTemplate = {
      spec: {
        containers: [elasticsearchHeapContainer(heap)],
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
  options: { heapSize?: string } = {},
) {
  const spec: Record<string, unknown> = {
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
  };

  const heap = normalizeHeapSize(options.heapSize);
  if (heap) {
    const memory = memoryLimitForHeap(heap);
    spec.podTemplate = {
      spec: {
        containers: [
          {
            name: "logstash",
            env: [
              {
                name: "LS_JAVA_OPTS",
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
    apiVersion: `${LS_GROUP}/${LS_API_VERSION}`,
    kind: "Logstash",
    metadata: { name: RESOURCE_NAME, namespace },
    spec,
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

function httpError(message: string, statusCode: number): Error & {
  statusCode: number;
} {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

export async function patchCustomObjectVersion(params: {
  group: string;
  version: string;
  namespace: string;
  plural: string;
  name: string;
  stackVersion: string;
  rejectDowngrade?: boolean;
}): Promise<void> {
  const { group, version, namespace, plural, name, stackVersion } = params;
  const { custom } = clients();
  let current: { spec?: { version?: unknown } };
  try {
    current = (await custom.getNamespacedCustomObject({
      group,
      version,
      namespace,
      plural,
      name,
    })) as { spec?: { version?: unknown } };
  } catch (err) {
    if (isNotFound(err)) {
      throw httpError(
        `${plural} "${name}" not found in namespace "${namespace}". Deploy it first.`,
        404,
      );
    }
    throw err;
  }

  const currentVersion =
    typeof current.spec?.version === "string"
      ? current.spec.version.trim()
      : "";
  if (
    params.rejectDowngrade &&
    currentVersion &&
    compareVersions(stackVersion, currentVersion) < 0
  ) {
    throw httpError(
      `Elasticsearch cannot be downgraded from ${currentVersion} to ${stackVersion}.`,
      400,
    );
  }
  if (currentVersion === stackVersion) return;

  await custom.patchNamespacedCustomObject({
    group,
    version,
    namespace,
    plural,
    name,
    body: [
      {
        op: currentVersion ? "replace" : "add",
        path: "/spec/version",
        value: stackVersion,
      },
    ],
  });
}

export async function upgradeElasticsearch(
  namespace: string,
  stackVersion: string,
): Promise<void> {
  await patchCustomObjectVersion({
    group: ES_GROUP,
    version: API_VERSION,
    namespace,
    plural: "elasticsearches",
    name: RESOURCE_NAME,
    stackVersion,
    rejectDowngrade: true,
  });
}

export async function updateElasticsearchTopology(
  namespace: string,
  options: {
    nodeCount?: number;
    heapSize?: string;
    patchHeap?: boolean;
  },
): Promise<void> {
  const { custom } = clients();
  let current: { spec?: Record<string, unknown> };
  try {
    current = (await custom.getNamespacedCustomObject({
      group: ES_GROUP,
      version: API_VERSION,
      namespace,
      plural: "elasticsearches",
      name: RESOURCE_NAME,
    })) as { spec?: Record<string, unknown> };
  } catch (err) {
    if (isNotFound(err)) {
      throw httpError(
        `elasticsearches "${RESOURCE_NAME}" not found in namespace "${namespace}". Deploy it first.`,
        404,
      );
    }
    throw err;
  }

  const spec = asRecord(current.spec) ?? {};
  const nodeSets = nodeSetsFromSpec(spec);
  if (nodeSets.length === 0) {
    throw httpError(
      "Elasticsearch has no nodeSets to update.",
      400,
    );
  }
  const index = defaultNodeSetIndex(nodeSets);
  let nodeSet = { ...nodeSets[index] };
  if (options.nodeCount !== undefined) {
    nodeSet = { ...nodeSet, count: normalizeNodeCount(options.nodeCount) };
  }
  if (options.patchHeap) {
    nodeSet = applyHeapToNodeSet(nodeSet, options.heapSize);
  }

  await custom.patchNamespacedCustomObject({
    group: ES_GROUP,
    version: API_VERSION,
    namespace,
    plural: "elasticsearches",
    name: RESOURCE_NAME,
    body: [
      {
        op: "replace",
        path: `/spec/nodeSets/${index}`,
        value: nodeSet,
      },
    ],
  });
}

export async function upgradeKibana(
  namespace: string,
  stackVersion: string,
): Promise<void> {
  await patchCustomObjectVersion({
    group: KB_GROUP,
    version: API_VERSION,
    namespace,
    plural: "kibanas",
    name: RESOURCE_NAME,
    stackVersion,
  });
}

export async function upgradeLogstash(
  namespace: string,
  stackVersion: string,
): Promise<void> {
  await patchCustomObjectVersion({
    group: LS_GROUP,
    version: LS_API_VERSION,
    namespace,
    plural: "logstashes",
    name: RESOURCE_NAME,
    stackVersion,
  });
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
  options: { heapSize?: string } = {},
): Promise<void> {
  const { custom } = clients();
  const body = buildLogstashManifest(version, namespace, configString, options);
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
    const nodeSets = nodeSetsFromSpec(spec);
    const nodeSet =
      nodeSets[defaultNodeSetIndex(nodeSets)] ?? nodeSets[0];
    const count =
      typeof nodeSet?.count === "number" ? nodeSet.count : undefined;

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
      count,
      heapSize: extractHeapSizeFromNodeSet(nodeSet),
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
    const [pods, liveServices] = await Promise.all([
      listPods(core, namespace, "logstash.k8s.elastic.co/name=quickstart"),
      listLogstashServices(core, namespace),
    ]);
    const services = mergeLogstashServices(
      liveServices,
      servicesFromLogstashSpec(spec, namespace),
    );

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

const RESTART_SELECTORS = {
  elasticsearch: "elasticsearch.k8s.elastic.co/name=quickstart",
  kibana: "kibana.k8s.elastic.co/name=quickstart",
  "fleet-server": "agent.k8s.elastic.co/name=fleet-server-quickstart",
  "elastic-agent": "agent.k8s.elastic.co/name=elastic-agent-quickstart",
} as const;

export type RestartableResource = keyof typeof RESTART_SELECTORS;

/** Delete pods for a resource so ECK recreates them (CR is unchanged). */
export async function restartPods(
  namespace: string,
  resource: RestartableResource,
): Promise<{ deleted: string[] }> {
  const { core } = clients();
  const labelSelector = RESTART_SELECTORS[resource];
  const res = await core.listNamespacedPod({ namespace, labelSelector });
  const deleted: string[] = [];
  for (const pod of res.items ?? []) {
    const name = pod.metadata?.name;
    if (!name) continue;
    try {
      await core.deleteNamespacedPod({ name, namespace });
      deleted.push(name);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  return { deleted };
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

function logstashServicePorts(
  namespace: string,
  serviceName: string,
  ports: Array<{
    name?: string;
    port: number;
    targetPort?: string | number;
    nodePort?: number;
    protocol?: string;
  }>,
): ServicePortInfo[] {
  return ports.map((p) => {
    const port = p.port;
    return {
      name: p.name || String(port),
      port,
      targetPort: p.targetPort,
      nodePort: p.nodePort,
      protocol: p.protocol || "TCP",
      forwardTarget: `svc:${serviceName}:${port}`,
      command: `kubectl -n ${namespace} port-forward service/${serviceName} ${port}:${port}`,
    };
  });
}

function servicesFromLogstashSpec(
  spec: Record<string, unknown>,
  namespace: string,
): ServiceInfo[] {
  const declared = spec.services;
  if (!Array.isArray(declared)) return [];

  return declared
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) return null;
      const item = entry as {
        name?: unknown;
        service?: { spec?: { type?: unknown; ports?: unknown } };
      };
      const shortName = typeof item.name === "string" ? item.name : "";
      if (!shortName) return null;
      const name = `${RESOURCE_NAME}-ls-${shortName}`;
      const svcSpec = item.service?.spec;
      const rawPorts = Array.isArray(svcSpec?.ports) ? svcSpec.ports : [];
      const ports = logstashServicePorts(
        namespace,
        name,
        rawPorts.flatMap((p) => {
          if (typeof p !== "object" || p === null) return [];
          const port = (p as { port?: unknown }).port;
          if (typeof port !== "number") return [];
          const targetPort = (p as { targetPort?: unknown }).targetPort;
          return [
            {
              name:
                typeof (p as { name?: unknown }).name === "string"
                  ? (p as { name: string }).name
                  : undefined,
              port,
              targetPort:
                typeof targetPort === "string" || typeof targetPort === "number"
                  ? targetPort
                  : undefined,
              protocol:
                typeof (p as { protocol?: unknown }).protocol === "string"
                  ? (p as { protocol: string }).protocol
                  : undefined,
            },
          ];
        }),
      );
      if (ports.length === 0) return null;
      return {
        name,
        type:
          typeof svcSpec?.type === "string" ? svcSpec.type : "ClusterIP",
        ports,
      } satisfies ServiceInfo;
    })
    .filter((svc): svc is ServiceInfo => svc !== null);
}

function mergeLogstashServices(
  live: ServiceInfo[],
  fromSpec: ServiceInfo[],
): ServiceInfo[] {
  if (live.length === 0) return fromSpec;
  const liveNames = new Set(live.map((svc) => svc.name));
  return [...live, ...fromSpec.filter((svc) => !liveNames.has(svc.name))].sort(
    (a, b) => a.name.localeCompare(b.name),
  );
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
      const ports = logstashServicePorts(
        namespace,
        name,
        (svc.spec?.ports ?? [])
          .filter(
            (p): p is k8s.V1ServicePort & { port: number } =>
              typeof p.port === "number",
          )
          .map((p) => ({
            name: p.name,
            port: p.port,
            targetPort:
              typeof p.targetPort === "object" && p.targetPort !== null
                ? undefined
                : (p.targetPort as string | number | undefined),
            nodePort: typeof p.nodePort === "number" ? p.nodePort : undefined,
            protocol: p.protocol,
          })),
      );

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

const ECK_OPERATOR_NAMESPACE = "elastic-system";
const ECK_TRIAL_SECRET_NAME = "eck-trial-license";
const ECK_LICENSING_CONFIGMAP = "elastic-licensing";
export const ECK_EULA_URL = "https://www.elastic.co/eula";

export type EckLicenseStatus = {
  operatorNamespace: string;
  level: string;
  trialSecretExists: boolean;
  canStartTrial: boolean;
  message?: string;
};

export async function getEckLicenseStatus(): Promise<EckLicenseStatus> {
  const { core } = clients();
  const operatorNamespace = ECK_OPERATOR_NAMESPACE;

  let level = "unknown";
  try {
    const cm = await core.readNamespacedConfigMap({
      name: ECK_LICENSING_CONFIGMAP,
      namespace: operatorNamespace,
    });
    const raw = cm.data?.eck_license_level?.trim();
    if (raw) level = raw.toLowerCase();
  } catch (err) {
    if (!isNotFound(err)) throw err;
    return {
      operatorNamespace,
      level: "unknown",
      trialSecretExists: false,
      canStartTrial: false,
      message:
        "ECK licensing ConfigMap not found. Is the operator installed in elastic-system?",
    };
  }

  let trialSecretExists = false;
  try {
    await core.readNamespacedSecret({
      name: ECK_TRIAL_SECRET_NAME,
      namespace: operatorNamespace,
    });
    trialSecretExists = true;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  if (!trialSecretExists) {
    try {
      const listed = await core.listNamespacedSecret({
        namespace: operatorNamespace,
        labelSelector: "license.k8s.elastic.co/type=enterprise_trial",
      });
      trialSecretExists = (listed.items ?? []).length > 0;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  const levelIsBasic = level === "basic" || level === "unknown";
  const canStartTrial = levelIsBasic && !trialSecretExists;

  let message: string | undefined;
  if (trialSecretExists && levelIsBasic) {
    message =
      "A trial secret already exists (or a trial was used before). ECK only allows one trial activation.";
  }

  return {
    operatorNamespace,
    level,
    trialSecretExists,
    canStartTrial,
    message,
  };
}

/** Start a 30-day Enterprise trial (requires accepting the Elastic EULA). */
export async function startEckTrial(options: {
  acceptEula: boolean;
}): Promise<EckLicenseStatus> {
  if (!options.acceptEula) {
    const err = new Error(
      `You must accept the Elastic EULA (${ECK_EULA_URL}) to start a trial.`,
    ) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }

  const status = await getEckLicenseStatus();
  if (!status.canStartTrial) {
    const err = new Error(
      status.message ||
        "Cannot start an Enterprise trial with the current license state.",
    ) as Error & { statusCode: number };
    err.statusCode = 409;
    throw err;
  }

  const { core } = clients();
  try {
    await core.createNamespacedSecret({
      namespace: status.operatorNamespace,
      body: {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: ECK_TRIAL_SECRET_NAME,
          namespace: status.operatorNamespace,
          labels: {
            "license.k8s.elastic.co/type": "enterprise_trial",
          },
          annotations: {
            "elastic.co/eula": "accepted",
          },
        },
      },
    });
  } catch (err) {
    if (isAlreadyExists(err)) {
      const conflict = new Error(
        "Trial license secret already exists. A trial can only be initiated once.",
      ) as Error & { statusCode: number };
      conflict.statusCode = 409;
      throw conflict;
    }
    throw err;
  }

  // Operator updates elastic-licensing asynchronously; return refreshed best-effort status.
  await new Promise((r) => setTimeout(r, 2_000));
  return getEckLicenseStatus();
}

const ECK_LICENSE_SECRET_NAME = "eck-license";
const MAX_LICENSE_JSON_BYTES = 1_000_000;

/** Apply an ECK orchestration Enterprise license JSON as a Secret in elastic-system. */
export async function applyEckEnterpriseLicense(
  licenseJson: string,
): Promise<EckLicenseStatus> {
  const trimmed = licenseJson.trim();
  if (!trimmed) {
    throw httpError("License JSON is required.", 400);
  }
  if (Buffer.byteLength(trimmed, "utf8") > MAX_LICENSE_JSON_BYTES) {
    throw httpError("License file is too large (max 1 MB).", 400);
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("not an object");
    }
  } catch {
    throw httpError("License file is not valid JSON.", 400);
  }

  const { core } = clients();
  const operatorNamespace = ECK_OPERATOR_NAMESPACE;
  let name = ECK_LICENSE_SECRET_NAME;
  try {
    await core.readNamespacedSecret({
      name,
      namespace: operatorNamespace,
    });
    name = `eck-license-${Date.now()}`;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  try {
    await core.createNamespacedSecret({
      namespace: operatorNamespace,
      body: {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name,
          namespace: operatorNamespace,
          labels: {
            "license.k8s.elastic.co/scope": "operator",
          },
        },
        type: "Opaque",
        stringData: { license: trimmed },
      },
    });
  } catch (err) {
    if (isAlreadyExists(err)) {
      name = `eck-license-${Date.now()}`;
      await core.createNamespacedSecret({
        namespace: operatorNamespace,
        body: {
          apiVersion: "v1",
          kind: "Secret",
          metadata: {
            name,
            namespace: operatorNamespace,
            labels: {
              "license.k8s.elastic.co/scope": "operator",
            },
          },
          type: "Opaque",
          stringData: { license: trimmed },
        },
      });
    } else {
      throw err;
    }
  }

  await new Promise((r) => setTimeout(r, 2_000));
  return getEckLicenseStatus();
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

export async function describePod(
  namespace: string,
  name: string,
): Promise<{ name: string; namespace: string; describe: string }> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw httpError("pod name is required", 400);
  }

  const args = [
    ...kubectlContextArgs(),
    "-n",
    namespace,
    "describe",
    "pod",
    trimmedName,
  ];

  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("kubectl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        httpError(
          stderr.trim() || `kubectl describe exited with code ${code}`,
          code === 1 ? 404 : 502,
        ),
      );
    });
  });

  return { name: trimmedName, namespace, describe: output };
}
