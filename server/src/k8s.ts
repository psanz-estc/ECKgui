import * as k8s from "@kubernetes/client-node";

const ES_GROUP = "elasticsearch.k8s.elastic.co";
const KB_GROUP = "kibana.k8s.elastic.co";
const LS_GROUP = "logstash.k8s.elastic.co";
const API_VERSION = "v1";
const LS_API_VERSION = "v1alpha1";
const RESOURCE_NAME = "quickstart";

export type ClusterInfo = {
  context: string;
  server: string;
  namespaces: string[];
};

export type PodInfo = {
  name: string;
  phase: string;
  ready: string;
  restarts: number;
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
};

type CustomApi = {
  createNamespacedCustomObject: (p: Record<string, unknown>) => Promise<unknown>;
  replaceNamespacedCustomObject: (p: Record<string, unknown>) => Promise<unknown>;
  deleteNamespacedCustomObject: (p: Record<string, unknown>) => Promise<unknown>;
  getNamespacedCustomObject: (p: Record<string, unknown>) => Promise<unknown>;
};

type CoreApi = {
  listNamespace: () => Promise<{ items?: k8s.V1Namespace[] }>;
  listNamespacedPod: (p: {
    namespace: string;
    labelSelector?: string;
  }) => Promise<{ items?: k8s.V1Pod[] }>;
  readNamespacedSecret: (p: {
    name: string;
    namespace: string;
  }) => Promise<k8s.V1Secret>;
};

function loadKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc;
}

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
  const cluster = kc.getCurrentCluster();
  const nsList = await core.listNamespace();
  const namespaces = (nsList.items ?? [])
    .map((n) => n.metadata?.name)
    .filter((n): n is string => Boolean(n))
    .sort();

  return {
    context,
    server: cluster?.server || "unknown",
    namespaces: namespaces.length > 0 ? namespaces : ["default"],
  };
}

function buildElasticsearchManifest(version: string, namespace: string) {
  return {
    apiVersion: `${ES_GROUP}/${API_VERSION}`,
    kind: "Elasticsearch",
    metadata: { name: RESOURCE_NAME, namespace },
    spec: {
      version,
      nodeSets: [
        {
          name: "default",
          count: 1,
          config: {
            "node.store.allow_mmap": false,
          },
        },
      ],
    },
  };
}

function buildKibanaManifest(version: string, namespace: string) {
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
): Promise<void> {
  const { custom } = clients();
  const body = buildElasticsearchManifest(version, namespace);
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

    return {
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
    };
  } catch (err) {
    if (isNotFound(err)) {
      return { name: RESOURCE_NAME, exists: false, pods: [] };
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

    return {
      name: RESOURCE_NAME,
      exists: true,
      version: String(spec.version ?? ""),
      health: status.health ? String(status.health) : undefined,
      count: typeof spec.count === "number" ? spec.count : undefined,
      pods,
    };
  } catch (err) {
    if (isNotFound(err)) {
      return { name: RESOURCE_NAME, exists: false, pods: [] };
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
    const pods = await listPods(
      core,
      namespace,
      "logstash.k8s.elastic.co/name=quickstart",
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

    return {
      name: RESOURCE_NAME,
      exists: true,
      version: String(spec.version ?? ""),
      health,
      count: typeof spec.count === "number" ? spec.count : undefined,
      nodes: available,
      configString: extractLogstashConfigString(spec),
      pods,
    };
  } catch (err) {
    if (isNotFound(err)) {
      return {
        name: RESOURCE_NAME,
        exists: false,
        pods: [],
        configString: null,
      };
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
    phase: pod.status?.phase || "Unknown",
    ready: podReady(pod),
    restarts: podRestarts(pod),
  }));
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
