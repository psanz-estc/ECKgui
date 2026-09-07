import * as k8s from "@kubernetes/client-node";
import { getElasticsearchStatus, type ResourceStatus } from "./k8s.js";
import { loadKubeConfig } from "./kubeconfig.js";

const BEAT_GROUP = "beat.k8s.elastic.co";
const BEAT_VERSION = "v1beta1";
const BEAT_PLURAL = "beats";
const ES_REF = "quickstart";
const KB_REF = "quickstart";

export const BEAT_NAMES = [
  "metricbeat",
  "filebeat",
  "packetbeat",
  "heartbeat",
] as const;

export type BeatName = (typeof BEAT_NAMES)[number];

type CustomApi = {
  createNamespacedCustomObject: (p: Record<string, unknown>) => Promise<unknown>;
  replaceNamespacedCustomObject: (p: Record<string, unknown>) => Promise<unknown>;
  deleteNamespacedCustomObject: (p: Record<string, unknown>) => Promise<unknown>;
  getNamespacedCustomObject: (p: Record<string, unknown>) => Promise<unknown>;
};

type CoreApi = {
  createNamespacedServiceAccount: (p: {
    namespace: string;
    body: k8s.V1ServiceAccount;
  }) => Promise<k8s.V1ServiceAccount>;
  deleteNamespacedServiceAccount: (p: {
    name: string;
    namespace: string;
  }) => Promise<unknown>;
  listNamespacedPod: (p: {
    namespace: string;
    labelSelector?: string;
  }) => Promise<{ items?: k8s.V1Pod[] }>;
};

type RbacApi = {
  createClusterRole: (p: { body: k8s.V1ClusterRole }) => Promise<k8s.V1ClusterRole>;
  replaceClusterRole: (p: {
    name: string;
    body: k8s.V1ClusterRole;
  }) => Promise<k8s.V1ClusterRole>;
  deleteClusterRole: (p: { name: string }) => Promise<unknown>;
  createClusterRoleBinding: (p: {
    body: k8s.V1ClusterRoleBinding;
  }) => Promise<k8s.V1ClusterRoleBinding>;
  replaceClusterRoleBinding: (p: {
    name: string;
    body: k8s.V1ClusterRoleBinding;
  }) => Promise<k8s.V1ClusterRoleBinding>;
  deleteClusterRoleBinding: (p: { name: string }) => Promise<unknown>;
};

function clients() {
  const kc = loadKubeConfig();
  return {
    core: kc.makeApiClient(k8s.CoreV1Api) as unknown as CoreApi,
    custom: kc.makeApiClient(k8s.CustomObjectsApi) as unknown as CustomApi,
    rbac: kc.makeApiClient(k8s.RbacAuthorizationV1Api) as unknown as RbacApi,
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

function isAlreadyExists(err: unknown): boolean {
  return getStatusCode(err) === 409;
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

function roleName(base: string, namespace: string): string {
  return `yaeu-${base}-${namespace}`.slice(0, 63);
}

async function applyCustomObject(
  custom: CustomApi,
  params: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
    name: string;
    body: Record<string, unknown>;
  },
): Promise<void> {
  const { group, version, namespace, plural, name, body } = params;
  try {
    await custom.createNamespacedCustomObject({
      group,
      version,
      namespace,
      plural,
      body,
    });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    const current = (await custom.getNamespacedCustomObject({
      group,
      version,
      namespace,
      plural,
      name,
    })) as { metadata?: { resourceVersion?: string } };
    await custom.replaceNamespacedCustomObject({
      group,
      version,
      name,
      namespace,
      plural,
      body: {
        ...body,
        metadata: {
          ...(body.metadata as object),
          resourceVersion: current.metadata?.resourceVersion,
        },
      },
    });
  }
}

async function deleteCustomObject(
  custom: CustomApi,
  params: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
    name: string;
  },
): Promise<void> {
  try {
    await custom.deleteNamespacedCustomObject(params);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

async function ensureServiceAccount(
  core: CoreApi,
  namespace: string,
  name: string,
): Promise<void> {
  try {
    await core.createNamespacedServiceAccount({
      namespace,
      body: {
        apiVersion: "v1",
        kind: "ServiceAccount",
        metadata: { name, namespace },
      },
    });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
  }
}

async function ensureClusterRole(
  rbac: RbacApi,
  name: string,
  rules: k8s.V1PolicyRule[],
): Promise<void> {
  const body: k8s.V1ClusterRole = {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "ClusterRole",
    metadata: { name },
    rules,
  };
  try {
    await rbac.createClusterRole({ body });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    await rbac.replaceClusterRole({ name, body });
  }
}

async function ensureClusterRoleBinding(
  rbac: RbacApi,
  name: string,
  roleNameValue: string,
  saName: string,
  namespace: string,
): Promise<void> {
  const body: k8s.V1ClusterRoleBinding = {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "ClusterRoleBinding",
    metadata: { name },
    subjects: [
      { kind: "ServiceAccount", name: saName, namespace },
    ],
    roleRef: {
      kind: "ClusterRole",
      name: roleNameValue,
      apiGroup: "rbac.authorization.k8s.io",
    },
  };
  try {
    await rbac.createClusterRoleBinding({ body });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    await rbac.replaceClusterRoleBinding({ name, body });
  }
}

function metricbeatRules(): k8s.V1PolicyRule[] {
  return [
    {
      apiGroups: [""],
      resources: ["nodes", "namespaces", "events", "pods"],
      verbs: ["get", "list", "watch"],
    },
    {
      apiGroups: ["events.k8s.io"],
      resources: ["events"],
      verbs: ["get", "list", "watch"],
    },
    {
      apiGroups: ["extensions"],
      resources: ["replicasets"],
      verbs: ["get", "list", "watch"],
    },
    {
      apiGroups: ["apps"],
      resources: ["statefulsets", "deployments", "replicasets"],
      verbs: ["get", "list", "watch"],
    },
    {
      apiGroups: [""],
      resources: ["nodes/stats"],
      verbs: ["get"],
    },
    {
      nonResourceURLs: ["/metrics"],
      verbs: ["get"],
    },
  ];
}

function filebeatRules(): k8s.V1PolicyRule[] {
  return [
    {
      apiGroups: [""],
      resources: ["namespaces", "pods", "nodes"],
      verbs: ["get", "watch", "list"],
    },
    {
      apiGroups: ["apps"],
      resources: ["replicasets"],
      verbs: ["get", "list", "watch"],
    },
    {
      apiGroups: ["batch"],
      resources: ["jobs"],
      verbs: ["get", "list", "watch"],
    },
  ];
}

function beatBody(
  name: BeatName,
  namespace: string,
  version: string,
): Record<string, unknown> {
  const base = {
    apiVersion: `${BEAT_GROUP}/${BEAT_VERSION}`,
    kind: "Beat",
    metadata: { name, namespace },
    spec: {
      type: name,
      version,
      elasticsearchRef: { name: ES_REF },
    },
  };

  if (name === "metricbeat") {
    return {
      ...base,
      spec: {
        ...base.spec,
        kibanaRef: { name: KB_REF },
        config: {
          metricbeat: {
            autodiscover: {
              providers: [
                {
                  hints: { default_config: {}, enabled: "true" },
                  enabled: true,
                  node: "${NODE_NAME}",
                  type: "kubernetes",
                },
              ],
            },
            modules: [
              {
                module: "system",
                period: "10s",
                metricsets: [
                  "cpu",
                  "load",
                  "memory",
                  "network",
                  "process",
                  "process_summary",
                ],
                process: {
                  include_top_n: { by_cpu: 5, by_memory: 5 },
                },
                processes: [".*"],
              },
              {
                module: "system",
                period: "1m",
                metricsets: ["filesystem", "fsstat"],
                processors: [
                  {
                    drop_event: {
                      when: {
                        regexp: {
                          system: { filesystem: { mount_point: "^/(sys|cgroup|proc|dev|etc|host|lib)($|/)" } },
                        },
                      },
                    },
                  },
                ],
              },
              {
                module: "kubernetes",
                period: "10s",
                node: "${NODE_NAME}",
                hosts: ["https://${NODE_NAME}:10250"],
                bearer_token_file:
                  "/var/run/secrets/kubernetes.io/serviceaccount/token",
                ssl: { verification_mode: "none" },
                metricsets: ["node", "system", "pod", "container", "volume"],
              },
            ],
          },
          processors: [{ add_cloud_metadata: {} }, { add_host_metadata: {} }],
        },
        daemonSet: {
          podTemplate: {
            spec: {
              serviceAccountName: "metricbeat",
              automountServiceAccountToken: true,
              containers: [
                {
                  name: "metricbeat",
                  args: ["-e", "-c", "/etc/beat.yml", "--system.hostfs=/hostfs"],
                  volumeMounts: [
                    { mountPath: "/hostfs/sys/fs/cgroup", name: "cgroup" },
                    { mountPath: "/var/run/docker.sock", name: "dockersock" },
                    { mountPath: "/hostfs/proc", name: "proc" },
                  ],
                  env: [
                    {
                      name: "NODE_NAME",
                      valueFrom: { fieldRef: { fieldPath: "spec.nodeName" } },
                    },
                  ],
                },
              ],
              dnsPolicy: "ClusterFirstWithHostNet",
              hostNetwork: true,
              securityContext: { runAsUser: 0 },
              terminationGracePeriodSeconds: 30,
              volumes: [
                { hostPath: { path: "/sys/fs/cgroup" }, name: "cgroup" },
                { hostPath: { path: "/var/run/docker.sock" }, name: "dockersock" },
                { hostPath: { path: "/proc" }, name: "proc" },
              ],
            },
          },
        },
      },
    };
  }

  if (name === "filebeat") {
    return {
      ...base,
      spec: {
        ...base.spec,
        kibanaRef: { name: KB_REF },
        config: {
          filebeat: {
            autodiscover: {
              providers: [
                {
                  type: "kubernetes",
                  node: "${NODE_NAME}",
                  hints: {
                    enabled: true,
                    default_config: {
                      type: "filestream",
                      id: "kubernetes-container-logs-${data.kubernetes.pod.name}-${data.kubernetes.container.id}",
                      paths: [
                        "/var/log/containers/*${data.kubernetes.container.id}.log",
                      ],
                      parsers: [{ container: {} }],
                      prospector: {
                        scanner: { "fingerprint.enabled": true, symlinks: true },
                      },
                      "file_identity.fingerprint": {},
                    },
                  },
                },
              ],
            },
          },
          processors: [{ add_cloud_metadata: {} }, { add_host_metadata: {} }],
        },
        daemonSet: {
          podTemplate: {
            spec: {
              serviceAccountName: "filebeat",
              automountServiceAccountToken: true,
              terminationGracePeriodSeconds: 30,
              dnsPolicy: "ClusterFirstWithHostNet",
              hostNetwork: true,
              containers: [
                {
                  name: "filebeat",
                  securityContext: { runAsUser: 0 },
                  volumeMounts: [
                    { name: "varlogcontainers", mountPath: "/var/log/containers" },
                    { name: "varlogpods", mountPath: "/var/log/pods" },
                    {
                      name: "varlibdockercontainers",
                      mountPath: "/var/lib/docker/containers",
                    },
                  ],
                  env: [
                    {
                      name: "NODE_NAME",
                      valueFrom: { fieldRef: { fieldPath: "spec.nodeName" } },
                    },
                  ],
                },
              ],
              volumes: [
                { name: "varlogcontainers", hostPath: { path: "/var/log/containers" } },
                { name: "varlogpods", hostPath: { path: "/var/log/pods" } },
                {
                  name: "varlibdockercontainers",
                  hostPath: { path: "/var/lib/docker/containers" },
                },
              ],
            },
          },
        },
      },
    };
  }

  if (name === "packetbeat") {
    return {
      ...base,
      spec: {
        ...base.spec,
        kibanaRef: { name: KB_REF },
        config: {
          "packetbeat.interfaces.device": "any",
          "packetbeat.protocols": [
            {
              type: "dns",
              ports: [53],
              include_authorities: true,
              include_additionals: true,
            },
            { type: "http", ports: [80, 8000, 8080, 9200] },
          ],
          "packetbeat.flows": { timeout: "30s", period: "10s" },
          processors: [{ add_cloud_metadata: {} }, { add_host_metadata: {} }],
        },
        daemonSet: {
          podTemplate: {
            spec: {
              terminationGracePeriodSeconds: 30,
              hostNetwork: true,
              automountServiceAccountToken: true,
              dnsPolicy: "ClusterFirstWithHostNet",
              containers: [
                {
                  name: "packetbeat",
                  securityContext: {
                    runAsUser: 0,
                    capabilities: { add: ["NET_ADMIN"] },
                  },
                },
              ],
            },
          },
        },
      },
    };
  }

  return {
    ...base,
    spec: {
      ...base.spec,
      config: {
        "heartbeat.monitors": [
          {
            type: "tcp",
            schedule: "@every 5s",
            hosts: [`${ES_REF}-es-http.${namespace}.svc:9200`],
          },
          {
            type: "tcp",
            schedule: "@every 5s",
            hosts: [`${KB_REF}-kb-http.${namespace}.svc:5601`],
          },
        ],
      },
      deployment: {
        replicas: 1,
        podTemplate: {
          spec: { securityContext: { runAsUser: 0 } },
        },
      },
    },
  };
}

async function applyBeatRbac(namespace: string): Promise<void> {
  const { core, rbac } = clients();
  const metricRole = roleName("metricbeat", namespace);
  const fileRole = roleName("filebeat", namespace);

  await ensureServiceAccount(core, namespace, "metricbeat");
  await ensureServiceAccount(core, namespace, "filebeat");
  await ensureClusterRole(rbac, metricRole, metricbeatRules());
  await ensureClusterRole(rbac, fileRole, filebeatRules());
  await ensureClusterRoleBinding(
    rbac,
    metricRole,
    metricRole,
    "metricbeat",
    namespace,
  );
  await ensureClusterRoleBinding(rbac, fileRole, fileRole, "filebeat", namespace);
}

async function deleteBeatRbac(namespace: string): Promise<void> {
  const { core, rbac } = clients();
  const metricRole = roleName("metricbeat", namespace);
  const fileRole = roleName("filebeat", namespace);

  for (const name of [metricRole, fileRole]) {
    try {
      await rbac.deleteClusterRoleBinding({ name });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    try {
      await rbac.deleteClusterRole({ name });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  for (const name of ["metricbeat", "filebeat"]) {
    try {
      await core.deleteNamespacedServiceAccount({ name, namespace });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}

export type BeatsStatus = {
  version?: string;
  beats: ResourceStatus[];
};

export async function getBeatsStatus(namespace: string): Promise<BeatsStatus> {
  const { custom, core } = clients();
  const beats: ResourceStatus[] = [];
  let version: string | undefined;

  for (const name of BEAT_NAMES) {
    try {
      const obj = (await custom.getNamespacedCustomObject({
        group: BEAT_GROUP,
        version: BEAT_VERSION,
        name,
        namespace,
        plural: BEAT_PLURAL,
      })) as Record<string, unknown>;
      const status = (obj.status ?? {}) as Record<string, unknown>;
      const spec = (obj.spec ?? {}) as Record<string, unknown>;
      const specVersion = String(spec.version ?? "");
      if (specVersion) version = specVersion;
      const res = await core.listNamespacedPod({
        namespace,
        labelSelector: `beat.k8s.elastic.co/name=${name}`,
      });
      beats.push({
        name,
        exists: true,
        version: specVersion,
        health: status.health ? String(status.health) : undefined,
        pods: (res.items ?? []).map((pod) => ({
          name: pod.metadata?.name || "unknown",
          phase: pod.metadata?.deletionTimestamp
            ? "Terminating"
            : pod.status?.phase || "Unknown",
          ready: (() => {
            const containers = pod.status?.containerStatuses ?? [];
            if (containers.length === 0) return "0/0";
            return `${containers.filter((c) => c.ready).length}/${containers.length}`;
          })(),
          restarts: (pod.status?.containerStatuses ?? []).reduce(
            (sum, c) => sum + (c.restartCount ?? 0),
            0,
          ),
        })),
      });
    } catch (err) {
      if (!isNotFound(err)) throw err;
      beats.push({ name, exists: false, pods: [] });
    }
  }

  return { version, beats };
}

export async function deployBeats(
  namespace: string,
  options: { version?: string; includePacketbeat?: boolean } = {},
): Promise<BeatsStatus> {
  const es = await getElasticsearchStatus(namespace);
  if (!es.exists) {
    throw httpError(
      `Elasticsearch "${ES_REF}" not found in namespace "${namespace}". Deploy it first.`,
      404,
    );
  }
  const version = options.version?.trim() || es.version?.trim();
  if (!version) {
    throw httpError("version is required when Elasticsearch has no spec.version", 400);
  }

  const includePacketbeat = options.includePacketbeat !== false;
  const { custom } = clients();
  await applyBeatRbac(namespace);

  const names: BeatName[] = includePacketbeat
    ? [...BEAT_NAMES]
    : BEAT_NAMES.filter((name) => name !== "packetbeat");

  for (const name of names) {
    await applyCustomObject(custom, {
      group: BEAT_GROUP,
      version: BEAT_VERSION,
      namespace,
      plural: BEAT_PLURAL,
      name,
      body: beatBody(name, namespace, version),
    });
  }

  if (!includePacketbeat) {
    await deleteCustomObject(custom, {
      group: BEAT_GROUP,
      version: BEAT_VERSION,
      namespace,
      plural: BEAT_PLURAL,
      name: "packetbeat",
    });
  }

  return getBeatsStatus(namespace);
}

export async function deleteBeats(namespace: string): Promise<void> {
  const { custom } = clients();
  for (const name of BEAT_NAMES) {
    await deleteCustomObject(custom, {
      group: BEAT_GROUP,
      version: BEAT_VERSION,
      namespace,
      plural: BEAT_PLURAL,
      name,
    });
  }
  await deleteBeatRbac(namespace);
}
