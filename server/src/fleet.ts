import * as k8s from "@kubernetes/client-node";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  deployElasticsearch,
  deployLogstash,
  getCredentials,
  getElasticsearchStatus,
  getKibanaStatus,
  getLogstashStatus,
  patchCustomObjectVersion,
  statusWhileTerminatingPods,
  upgradeElasticsearch,
  upgradeKibana,
  upgradeLogstash,
  type PodInfo,
  type ResourceStatus,
} from "./k8s.js";
import { loadKubeConfig } from "./kubeconfig.js";
import {
  getPortForwardState,
  startPortForward,
  stopPortForward,
} from "./portforward.js";

const execFileAsync = promisify(execFile);

const KB_GROUP = "kibana.k8s.elastic.co";
const AGENT_GROUP = "agent.k8s.elastic.co";
const API_VERSION = "v1";
const AGENT_API_VERSION = "v1alpha1";
const RESOURCE_NAME = "quickstart";
export const FLEET_SERVER_NAME = "fleet-server-quickstart";
export const ELASTIC_AGENT_NAME = "elastic-agent-quickstart";
const FLEET_SERVER_SA = "fleet-server";
const ELASTIC_AGENT_SA = "elastic-agent";
const PERMISSIONS_DS = "manage-agent-hostpath-permissions";
const APM_SERVICE = "apm";

export const DEFAULT_LOGSTASH_CONFIG = `input {
  beats {
    port => 5044
  }
}
output {
  elasticsearch {
    hosts => [ "\${QS_ES_HOSTS}" ]
    user => "\${QS_ES_USER}"
    password => "\${QS_ES_PASSWORD}"
    ssl_certificate_authorities => "\${QS_ES_SSL_CERTIFICATE_AUTHORITY}"
  }
}
`;

export type FleetExampleId =
  | "quickstart"
  | "kubernetes"
  | "kubernetes-nonroot"
  | "custom-logs"
  | "apm";

export type FleetExampleMeta = {
  id: FleetExampleId;
  name: string;
  description: string;
  note?: string;
};

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
  createNamespacedService: (p: {
    namespace: string;
    body: k8s.V1Service;
  }) => Promise<k8s.V1Service>;
  replaceNamespacedService: (p: {
    name: string;
    namespace: string;
    body: k8s.V1Service;
  }) => Promise<k8s.V1Service>;
  readNamespacedService: (p: {
    name: string;
    namespace: string;
  }) => Promise<k8s.V1Service>;
  deleteNamespacedService: (p: {
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
  readClusterRole: (p: { name: string }) => Promise<k8s.V1ClusterRole>;
  deleteClusterRole: (p: { name: string }) => Promise<unknown>;
  createClusterRoleBinding: (p: {
    body: k8s.V1ClusterRoleBinding;
  }) => Promise<k8s.V1ClusterRoleBinding>;
  replaceClusterRoleBinding: (p: {
    name: string;
    body: k8s.V1ClusterRoleBinding;
  }) => Promise<k8s.V1ClusterRoleBinding>;
  readClusterRoleBinding: (p: {
    name: string;
  }) => Promise<k8s.V1ClusterRoleBinding>;
  deleteClusterRoleBinding: (p: { name: string }) => Promise<unknown>;
};

type AppsApi = {
  createNamespacedDaemonSet: (p: {
    namespace: string;
    body: k8s.V1DaemonSet;
  }) => Promise<k8s.V1DaemonSet>;
  replaceNamespacedDaemonSet: (p: {
    name: string;
    namespace: string;
    body: k8s.V1DaemonSet;
  }) => Promise<k8s.V1DaemonSet>;
  readNamespacedDaemonSet: (p: {
    name: string;
    namespace: string;
  }) => Promise<k8s.V1DaemonSet>;
  deleteNamespacedDaemonSet: (p: {
    name: string;
    namespace: string;
  }) => Promise<unknown>;
};

function clients() {
  const kc = loadKubeConfig();
  return {
    core: kc.makeApiClient(k8s.CoreV1Api) as unknown as CoreApi,
    custom: kc.makeApiClient(k8s.CustomObjectsApi) as unknown as CustomApi,
    rbac: kc.makeApiClient(k8s.RbacAuthorizationV1Api) as unknown as RbacApi,
    apps: kc.makeApiClient(k8s.AppsV1Api) as unknown as AppsApi,
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

function roleName(base: string, namespace: string): string {
  return `yaeu-${base}-${namespace}`.slice(0, 63);
}

function esHttpHost(namespace: string): string {
  return `https://${RESOURCE_NAME}-es-http.${namespace}.svc:9200`;
}

function fleetServerHost(namespace: string): string {
  return `https://${FLEET_SERVER_NAME}-agent-http.${namespace}.svc:8220`;
}

function fleetServerPolicy() {
  // Matches elastic/support eck-lab-automation and ECK fleet recipes.
  return {
    name: "Fleet Server on ECK policy",
    id: "eck-fleet-server",
    namespace: "default",
    is_managed: true,
    monitoring_enabled: ["logs", "metrics"],
    unenroll_timeout: 900,
    package_policies: [
      {
        name: "fleet_server-1",
        id: "fleet_server-1",
        package: { name: "fleet_server" },
      },
    ],
  };
}

function agentPolicyBase() {
  return {
    name: "Elastic Agent on ECK policy",
    id: "eck-agent",
    namespace: "default",
    is_managed: true,
    monitoring_enabled: ["logs", "metrics"],
    unenroll_timeout: 900,
  };
}

function fleetElasticsearchOutput(
  namespace: string,
  withAssociationCa: boolean,
) {
  const output: Record<string, unknown> = {
    // Overwrite Kibana's built-in default output id so hosts are not left
    // as http://localhost:9200 after a Kibana-first deploy.
    id: "fleet-default-output",
    name: "default",
    type: "elasticsearch",
    is_default: true,
    is_default_monitoring: true,
    hosts: [esHttpHost(namespace)],
  };
  if (withAssociationCa) {
    output.ssl = {
      certificate_authorities: [
        `/mnt/elastic-internal/elasticsearch-association/${namespace}/${RESOURCE_NAME}/certs/ca.crt`,
      ],
    };
  }
  return output;
}

function kibanaFleetConfig(
  namespace: string,
  exampleId: FleetExampleId,
  options: { includeAgentPolicy: boolean } = { includeAgentPolicy: true },
): Record<string, unknown> {
  const packages: Array<{ name: string; version: string }> = [
    { name: "system", version: "latest" },
    { name: "elastic_agent", version: "latest" },
    { name: "fleet_server", version: "latest" },
  ];

  let packagePolicies: unknown[] = [
    {
      name: "system-1",
      id: "system-1",
      package: { name: "system" },
    },
  ];

  if (exampleId === "kubernetes" || exampleId === "kubernetes-nonroot") {
    packages.push({ name: "kubernetes", version: "latest" });
    packagePolicies = [
      { package: { name: "system" }, name: "system-1" },
      { package: { name: "kubernetes" }, name: "kubernetes-1" },
    ];
  } else if (exampleId === "custom-logs") {
    packages.push({ name: "log", version: "latest" });
    packagePolicies = [
      {
        name: "system-1",
        id: "system-1",
        package: { name: "system" },
      },
      {
        package: { name: "log" },
        name: "log-1",
        inputs: [
          {
            type: "logfile",
            enabled: true,
            streams: [
              {
                data_stream: { dataset: "log.log" },
                enabled: true,
                vars: [
                  {
                    name: "paths",
                    value: [
                      "/var/log/containers/*${kubernetes.container.id}.log",
                    ],
                  },
                  {
                    name: "custom",
                    value: `symlinks: true\ncondition: \${kubernetes.namespace} == '${namespace}'\n`,
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
  } else if (exampleId === "apm") {
    packages.push({ name: "apm", version: "latest" });
    packagePolicies = [
      {
        name: "system-1",
        id: "system-1",
        package: { name: "system" },
      },
      {
        package: { name: "apm" },
        name: "apm-1",
        inputs: [
          {
            type: "apm",
            enabled: true,
            vars: [{ name: "host", value: "0.0.0.0:8200" }],
          },
        ],
      },
    ];
  }

  const agentPolicies: unknown[] = [fleetServerPolicy()];
  if (options.includeAgentPolicy) {
    agentPolicies.push({
      ...agentPolicyBase(),
      package_policies: packagePolicies,
    });
  }

  // Kibana 9.x rejects elasticsearch.hosts together with a default
  // xpack.fleet.outputs. Prefer outputs (id=fleet-default-output) so a
  // prior localhost default is overwritten — same end state as eck-deploy.sh.
  return {
    "xpack.fleet.agents.fleet_server.hosts": [fleetServerHost(namespace)],
    "xpack.fleet.outputs": [
      fleetElasticsearchOutput(
        namespace,
        exampleId === "kubernetes-nonroot",
      ),
    ],
    "xpack.fleet.packages": packages,
    "xpack.fleet.agentPolicies": agentPolicies,
  };
}

function buildKibanaWithFleet(
  version: string,
  namespace: string,
  exampleId: FleetExampleId,
  options: { includeAgentPolicy: boolean } = { includeAgentPolicy: true },
) {
  return {
    apiVersion: `${KB_GROUP}/${API_VERSION}`,
    kind: "Kibana",
    metadata: { name: RESOURCE_NAME, namespace },
    spec: {
      version,
      count: 1,
      elasticsearchRef: { name: RESOURCE_NAME },
      config: kibanaFleetConfig(namespace, exampleId, options),
    },
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForKibanaGreen(
  namespace: string,
  timeoutMs = 300_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const kb = await getKibanaStatus(namespace);
    if (kb.exists && (kb.health || "").toLowerCase() === "green") {
      return;
    }
    await sleep(5_000);
  }
  const err = new Error(
    "Timed out waiting for Kibana to become green with Fleet config.",
  ) as Error & { statusCode: number };
  err.statusCode = 504;
  throw err;
}

/** Force Fleet default output hosts if preconfig left localhost behind. */
async function ensureFleetDefaultOutputHosts(
  namespace: string,
): Promise<void> {
  const creds = await getCredentials(namespace);
  if (!creds.password) return;

  const alreadyForwarding =
    getPortForwardState("kibana").status === "running" &&
    getPortForwardState("kibana").namespace === namespace;
  if (!alreadyForwarding) {
    await startPortForward("kibana", namespace);
  }

  const body = JSON.stringify({
    name: "default",
    type: "elasticsearch",
    hosts: [esHttpHost(namespace)],
    is_default: true,
    is_default_monitoring: true,
  });

  try {
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const { stdout } = await execFileAsync(
          "curl",
          [
            "-sk",
            "-u",
            `elastic:${creds.password}`,
            "-H",
            "kbn-xsrf: true",
            "-H",
            "Content-Type: application/json",
            "-X",
            "PUT",
            "https://127.0.0.1:5601/api/fleet/outputs/fleet-default-output",
            "--data-binary",
            body,
          ],
          { timeout: 20_000, maxBuffer: 2_000_000 },
        );
        if (
          stdout.includes(esHttpHost(namespace)) ||
          stdout.includes('"id":"fleet-default-output"') ||
          stdout.includes('"hosts"')
        ) {
          if (!stdout.toLowerCase().includes('"status_code":400')) {
            return;
          }
        }
      } catch {
        // Kibana/Fleet may still be settling; retry.
      }
      await sleep(5_000);
    }
  } finally {
    if (!alreadyForwarding) {
      await stopPortForward("kibana");
    }
  }
}

function fleetServerAgentManifest(
  version: string,
  namespace: string,
  exampleId: FleetExampleId,
) {
  const runAsRoot = exampleId !== "kubernetes-nonroot";
  return {
    apiVersion: `${AGENT_GROUP}/${AGENT_API_VERSION}`,
    kind: "Agent",
    metadata: { name: FLEET_SERVER_NAME, namespace },
    spec: {
      version,
      kibanaRef: { name: RESOURCE_NAME },
      elasticsearchRefs: [{ name: RESOURCE_NAME }],
      mode: "fleet",
      fleetServerEnabled: true,
      policyID: "eck-fleet-server",
      deployment: {
        replicas: 1,
        podTemplate: {
          spec: {
            serviceAccountName: FLEET_SERVER_SA,
            automountServiceAccountToken: true,
            ...(runAsRoot
              ? { securityContext: { runAsUser: 0 } }
              : {}),
          },
        },
      },
    },
  };
}

function elasticAgentManifest(
  version: string,
  namespace: string,
  exampleId: FleetExampleId,
) {
  const base = {
    apiVersion: `${AGENT_GROUP}/${AGENT_API_VERSION}`,
    kind: "Agent",
    metadata: { name: ELASTIC_AGENT_NAME, namespace },
    spec: {
      version,
      kibanaRef: { name: RESOURCE_NAME },
      fleetServerRef: { name: FLEET_SERVER_NAME },
      mode: "fleet",
      policyID: "eck-agent",
    } as Record<string, unknown>,
  };

  if (exampleId === "apm") {
    base.spec.deployment = {
      replicas: 1,
      podTemplate: {
        spec: {
          securityContext: { runAsUser: 0 },
        },
      },
    };
    return base;
  }

  if (exampleId === "custom-logs") {
    base.spec.daemonSet = {
      podTemplate: {
        spec: {
          serviceAccountName: ELASTIC_AGENT_SA,
          automountServiceAccountToken: true,
          securityContext: { runAsUser: 0 },
          containers: [
            {
              name: "agent",
              volumeMounts: [
                {
                  mountPath: "/var/lib/docker/containers",
                  name: "varlibdockercontainers",
                },
                { mountPath: "/var/log/containers", name: "varlogcontainers" },
                { mountPath: "/var/log/pods", name: "varlogpods" },
              ],
            },
          ],
          volumes: [
            {
              name: "varlibdockercontainers",
              hostPath: { path: "/var/lib/docker/containers" },
            },
            {
              name: "varlogcontainers",
              hostPath: { path: "/var/log/containers" },
            },
            { name: "varlogpods", hostPath: { path: "/var/log/pods" } },
          ],
        },
      },
    };
    return base;
  }

  if (exampleId === "kubernetes" || exampleId === "kubernetes-nonroot") {
    base.spec.daemonSet = {
      podTemplate: {
        spec: {
          serviceAccountName: ELASTIC_AGENT_SA,
          hostNetwork: true,
          dnsPolicy: "ClusterFirstWithHostNet",
          automountServiceAccountToken: true,
          ...(exampleId === "kubernetes"
            ? { securityContext: { runAsUser: 0 } }
            : {}),
        },
      },
    };
    return base;
  }

  // quickstart
  base.spec.daemonSet = {
    podTemplate: {
      spec: {
        serviceAccountName: ELASTIC_AGENT_SA,
        automountServiceAccountToken: true,
        securityContext: { runAsUser: 0 },
        volumes: [{ name: "agent-data", emptyDir: {} }],
      },
    },
  };
  return base;
}

function fleetServerRoleRules(): k8s.V1PolicyRule[] {
  return [
    {
      apiGroups: [""],
      resources: ["pods", "namespaces", "nodes"],
      verbs: ["get", "watch", "list"],
    },
    {
      apiGroups: ["apps"],
      resources: ["replicasets"],
      verbs: ["get", "watch", "list"],
    },
    {
      apiGroups: ["batch"],
      resources: ["jobs"],
      verbs: ["get", "watch", "list"],
    },
    {
      apiGroups: ["coordination.k8s.io"],
      resources: ["leases"],
      verbs: ["get", "create", "update"],
    },
  ];
}

function elasticAgentRoleRules(exampleId: FleetExampleId): k8s.V1PolicyRule[] {
  if (exampleId === "quickstart") {
    return [
      {
        apiGroups: [""],
        resources: ["pods", "nodes", "namespaces"],
        verbs: ["get", "watch", "list"],
      },
      {
        apiGroups: ["coordination.k8s.io"],
        resources: ["leases"],
        verbs: ["get", "create", "update"],
      },
      {
        apiGroups: ["apps"],
        resources: ["replicasets"],
        verbs: ["list", "watch"],
      },
      {
        apiGroups: ["batch"],
        resources: ["jobs"],
        verbs: ["list", "watch"],
      },
    ];
  }

  if (exampleId === "custom-logs") {
    return [
      {
        apiGroups: [""],
        resources: ["pods", "nodes", "namespaces", "events", "services", "configmaps"],
        verbs: ["get", "watch", "list"],
      },
      {
        apiGroups: ["events.k8s.io"],
        resources: ["events"],
        verbs: ["get", "watch", "list"],
      },
      {
        apiGroups: ["coordination.k8s.io"],
        resources: ["leases"],
        verbs: ["get", "create", "update"],
      },
      { nonResourceURLs: ["/metrics"], verbs: ["get"] },
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
        apiGroups: ["batch"],
        resources: ["jobs"],
        verbs: ["get", "list", "watch"],
      },
    ];
  }

  // kubernetes / kubernetes-nonroot / apm (fleet-server still needs SA; agent uses broad k8s rules for k8s packs)
  if (exampleId === "apm") {
    return fleetServerRoleRules();
  }

  return [
    {
      apiGroups: [""],
      resources: [
        "nodes",
        "nodes/metrics",
        "nodes/proxy",
        "nodes/stats",
        "namespaces",
        "pods",
        "services",
        "configmaps",
        "events",
        "persistentvolumes",
        "persistentvolumeclaims",
        "persistentvolumeclaims/status",
      ],
      verbs: ["get", "watch", "list"],
    },
    {
      apiGroups: ["events.k8s.io"],
      resources: ["events"],
      verbs: ["get", "watch", "list"],
    },
    {
      apiGroups: ["coordination.k8s.io"],
      resources: ["leases"],
      verbs: ["get", "create", "update"],
    },
    {
      nonResourceURLs: ["/metrics"],
      verbs: ["get", "watch", "list"],
    },
    {
      nonResourceURLs: [
        "/healthz",
        "/healthz/*",
        "/livez",
        "/livez/*",
        "/metrics/slis",
        "/readyz",
        "/readyz/*",
      ],
      verbs: ["get"],
    },
    {
      apiGroups: ["apps"],
      resources: ["replicasets", "deployments", "daemonsets", "statefulsets"],
      verbs: ["get", "list", "watch"],
    },
    {
      apiGroups: ["batch"],
      resources: ["jobs", "cronjobs"],
      verbs: ["get", "list", "watch"],
    },
    {
      apiGroups: ["storage.k8s.io"],
      resources: ["storageclasses"],
      verbs: ["get", "list", "watch"],
    },
  ];
}

export const FLEET_EXAMPLES: FleetExampleMeta[] = [
  {
    id: "quickstart",
    name: "System integration",
    description:
      "DaemonSet Elastic Agent with the system integration. Requires Fleet Server (Deploy Fleet).",
  },
  {
    id: "kubernetes",
    name: "System and Kubernetes",
    description:
      "DaemonSet agent with System and Kubernetes integrations (hostNetwork).",
  },
  {
    id: "kubernetes-nonroot",
    name: "System and Kubernetes (non-root)",
    description:
      "Same integrations running Elastic Agent as non-root, with a permissions DaemonSet.",
    note: "Requires ECK >= 2.10.",
  },
  {
    id: "custom-logs",
    name: "Custom logs (autodiscover)",
    description:
      "DaemonSet agent collecting Pod logs in the selected namespace via the log integration.",
  },
  {
    id: "apm",
    name: "APM integration",
    description:
      "Deployment agent with APM integration and an in-cluster APM Service on port 8200.",
  },
];

export function listFleetExamples(): FleetExampleMeta[] {
  return FLEET_EXAMPLES;
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
      {
        kind: "ServiceAccount",
        name: saName,
        namespace,
      },
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

async function applyFleetRbac(
  namespace: string,
  exampleId: FleetExampleId,
): Promise<void> {
  const { core, rbac } = clients();
  const fsRole = roleName("fleet-server", namespace);
  const eaRole = roleName("elastic-agent", namespace);

  await ensureServiceAccount(core, namespace, FLEET_SERVER_SA);
  await ensureServiceAccount(core, namespace, ELASTIC_AGENT_SA);
  await ensureClusterRole(rbac, fsRole, fleetServerRoleRules());
  await ensureClusterRole(rbac, eaRole, elasticAgentRoleRules(exampleId));
  await ensureClusterRoleBinding(
    rbac,
    fsRole,
    fsRole,
    FLEET_SERVER_SA,
    namespace,
  );
  await ensureClusterRoleBinding(
    rbac,
    eaRole,
    eaRole,
    ELASTIC_AGENT_SA,
    namespace,
  );
}

async function applyPermissionsDaemonSet(namespace: string): Promise<void> {
  const { apps } = clients();
  const body: k8s.V1DaemonSet = {
    apiVersion: "apps/v1",
    kind: "DaemonSet",
    metadata: { name: PERMISSIONS_DS, namespace },
    spec: {
      selector: { matchLabels: { name: PERMISSIONS_DS } },
      template: {
        metadata: { labels: { name: PERMISSIONS_DS } },
        spec: {
          volumes: [
            {
              name: "agent-data",
              hostPath: {
                path: "/var/lib/elastic-agent",
                type: "DirectoryOrCreate",
              },
            },
          ],
          initContainers: [
            {
              name: "manage-agent-hostpath-permissions",
              image: "docker.io/bash:5.2.15",
              resources: {
                limits: { cpu: "100m", memory: "32Mi" },
              },
              securityContext: { runAsUser: 0 },
              volumeMounts: [
                { mountPath: "/var/lib/elastic-agent", name: "agent-data" },
              ],
              command: [
                "bash",
                "-e",
                "-c",
                `dirs=(
"/var/lib/elastic-agent/${namespace}/${ELASTIC_AGENT_NAME}/state"
"/var/lib/elastic-agent/${namespace}/${FLEET_SERVER_NAME}/state"
)
for dir in \${dirs[@]}; do
  mkdir -p "\${dir}"
  chmod g+rw "\${dir}"
  chgrp 1000 "\${dir}"
  if [ -n "$(ls -A \${dir} 2>/dev/null)" ]; then
    chgrp 1000 "\${dir}"/*
    chmod g+rw "\${dir}"/*
  fi
done`,
              ],
            },
          ],
          containers: [
            {
              name: "pause",
              image: "gcr.io/google-containers/pause-amd64:3.1",
            },
          ],
        },
      },
    },
  };

  try {
    await apps.createNamespacedDaemonSet({ namespace, body });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    const current = await apps.readNamespacedDaemonSet({
      name: PERMISSIONS_DS,
      namespace,
    });
    body.metadata = {
      ...body.metadata,
      resourceVersion: current.metadata?.resourceVersion,
    };
    await apps.replaceNamespacedDaemonSet({
      name: PERMISSIONS_DS,
      namespace,
      body,
    });
  }
}

async function deletePermissionsDaemonSet(namespace: string): Promise<void> {
  const { apps } = clients();
  try {
    await apps.deleteNamespacedDaemonSet({ name: PERMISSIONS_DS, namespace });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

async function applyApmService(namespace: string): Promise<void> {
  const { core } = clients();
  const body: k8s.V1Service = {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: APM_SERVICE, namespace },
    spec: {
      selector: {
        "agent.k8s.elastic.co/name": ELASTIC_AGENT_NAME,
      },
      ports: [{ protocol: "TCP", port: 8200 }],
    },
  };
  try {
    await core.createNamespacedService({ namespace, body });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    const current = await core.readNamespacedService({
      name: APM_SERVICE,
      namespace,
    });
    body.metadata = {
      ...body.metadata,
      resourceVersion: current.metadata?.resourceVersion,
    };
    await core.replaceNamespacedService({
      name: APM_SERVICE,
      namespace,
      body,
    });
  }
}

async function deleteApmService(namespace: string): Promise<void> {
  const { core } = clients();
  try {
    await core.deleteNamespacedService({ name: APM_SERVICE, namespace });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

async function deployKibanaWithFleet(
  namespace: string,
  version: string,
  exampleId: FleetExampleId,
  options: { includeAgentPolicy: boolean } = { includeAgentPolicy: true },
): Promise<void> {
  const { custom } = clients();
  await applyCustomObject(custom, {
    group: KB_GROUP,
    version: API_VERSION,
    namespace,
    plural: "kibanas",
    name: RESOURCE_NAME,
    body: buildKibanaWithFleet(version, namespace, exampleId, options),
  });
}

async function deployAgent(
  namespace: string,
  name: string,
  body: Record<string, unknown>,
): Promise<void> {
  const { custom } = clients();
  await applyCustomObject(custom, {
    group: AGENT_GROUP,
    version: AGENT_API_VERSION,
    namespace,
    plural: "agents",
    name,
    body,
  });
}

export async function deleteFleetServer(namespace: string): Promise<void> {
  const { custom } = clients();
  await deleteCustomObject(custom, {
    group: AGENT_GROUP,
    version: AGENT_API_VERSION,
    namespace,
    plural: "agents",
    name: FLEET_SERVER_NAME,
  });
}

export async function deleteElasticAgent(namespace: string): Promise<void> {
  const { custom } = clients();
  await deleteCustomObject(custom, {
    group: AGENT_GROUP,
    version: AGENT_API_VERSION,
    namespace,
    plural: "agents",
    name: ELASTIC_AGENT_NAME,
  });
}

export async function deleteFleetRbac(namespace: string): Promise<void> {
  const { core, rbac } = clients();
  const names = [
    roleName("fleet-server", namespace),
    roleName("elastic-agent", namespace),
    `eckgui-fleet-server-${namespace}`.slice(0, 63),
    `eckgui-elastic-agent-${namespace}`.slice(0, 63),
  ];

  for (const name of names) {
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

  for (const sa of [FLEET_SERVER_SA, ELASTIC_AGENT_SA]) {
    try {
      await core.deleteNamespacedServiceAccount({ name: sa, namespace });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}

/** Delete Agents, APM service, permissions DS, and YAEU Fleet RBAC. */
export async function deleteFleetResources(namespace: string): Promise<void> {
  await deleteElasticAgent(namespace);
  await deleteFleetServer(namespace);
  await deleteApmService(namespace);
  await deletePermissionsDaemonSet(namespace);
  await deleteFleetRbac(namespace);
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

function agentPodPhase(pod: k8s.V1Pod): string {
  if (pod.metadata?.deletionTimestamp) return "Terminating";
  return pod.status?.phase || "Unknown";
}

async function listAgentPods(
  namespace: string,
  agentName: string,
): Promise<PodInfo[]> {
  const { core } = clients();
  const res = await core.listNamespacedPod({
    namespace,
    labelSelector: `agent.k8s.elastic.co/name=${agentName}`,
  });
  return (res.items ?? []).map((pod) => ({
    name: pod.metadata?.name || "unknown",
    phase: agentPodPhase(pod),
    ready: podReady(pod),
    restarts: podRestarts(pod),
  }));
}

async function getAgentStatus(
  namespace: string,
  name: string,
): Promise<ResourceStatus> {
  const { custom } = clients();
  try {
    const obj = (await custom.getNamespacedCustomObject({
      group: AGENT_GROUP,
      version: AGENT_API_VERSION,
      name,
      namespace,
      plural: "agents",
    })) as Record<string, unknown>;

    const status = (obj.status ?? {}) as Record<string, unknown>;
    const spec = (obj.spec ?? {}) as Record<string, unknown>;
    const pods = await listAgentPods(namespace, name);

    const base: ResourceStatus = {
      name,
      exists: true,
      version: String(spec.version ?? ""),
      health: status.health ? String(status.health) : undefined,
      nodes:
        typeof status.availableNodes === "number"
          ? status.availableNodes
          : typeof status.available === "number"
            ? status.available
            : undefined,
      count:
        typeof status.expectedNodes === "number"
          ? status.expectedNodes
          : undefined,
      pods,
    };
    if (
      pods.length > 0 &&
      pods.every((p) => p.phase === "Terminating")
    ) {
      return { ...base, health: "terminating", phase: "Terminating" };
    }
    return base;
  } catch (err) {
    if (isNotFound(err)) {
      const terminating = await statusWhileTerminatingPods(
        name,
        `agent.k8s.elastic.co/name=${name}`,
        namespace,
      );
      return terminating ?? { name, exists: false, pods: [] };
    }
    throw err;
  }
}

export function getFleetServerStatus(namespace: string) {
  return getAgentStatus(namespace, FLEET_SERVER_NAME);
}

export function getElasticAgentStatus(namespace: string) {
  return getAgentStatus(namespace, ELASTIC_AGENT_NAME);
}

export async function deployFleetPack(
  namespace: string,
  version: string,
  exampleId: FleetExampleId,
): Promise<void> {
  const es = await getElasticsearchStatus(namespace);
  if (!es.exists) {
    const err = new Error(
      "Deploy Elasticsearch first before agent configurations.",
    ) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }

  // Full agent pack: FS + data-plane policy (like ECK recipe YAMLs).
  await deployKibanaWithFleet(namespace, version, exampleId, {
    includeAgentPolicy: true,
  });
  await waitForKibanaGreen(namespace);
  await ensureFleetDefaultOutputHosts(namespace);
  await applyFleetRbac(namespace, exampleId);

  if (exampleId === "kubernetes-nonroot") {
    await applyPermissionsDaemonSet(namespace);
  } else {
    await deletePermissionsDaemonSet(namespace);
  }

  await deployAgent(
    namespace,
    FLEET_SERVER_NAME,
    fleetServerAgentManifest(version, namespace, exampleId),
  );
  await deployAgent(
    namespace,
    ELASTIC_AGENT_NAME,
    elasticAgentManifest(version, namespace, exampleId),
  );

  if (exampleId === "apm") {
    await applyApmService(namespace);
  } else {
    await deleteApmService(namespace);
  }
}

/** Fleet Server + Kibana Fleet config only (no data-plane Elastic Agent). */
export async function deployFleetServer(
  namespace: string,
  version: string,
): Promise<void> {
  const es = await getElasticsearchStatus(namespace);
  if (!es.exists) {
    const err = new Error(
      "Deploy Elasticsearch first before Fleet Server.",
    ) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }

  // Match eck-lab-automation --fleet: Kibana Fleet config + Fleet Server only.
  const exampleId: FleetExampleId = "quickstart";
  await deployKibanaWithFleet(namespace, version, exampleId, {
    includeAgentPolicy: false,
  });
  await waitForKibanaGreen(namespace);
  await ensureFleetDefaultOutputHosts(namespace);
  await applyFleetRbac(namespace, exampleId);
  await deployAgent(
    namespace,
    FLEET_SERVER_NAME,
    fleetServerAgentManifest(version, namespace, exampleId),
  );
}

export async function deployAllQuickstart(
  namespace: string,
  version: string,
  options: {
    includeLogstash?: boolean;
    configString?: string;
    heapSize?: string;
    lsHeapSize?: string;
    nodeCount?: number;
  } = {},
): Promise<void> {
  const includeLogstash = options.includeLogstash !== false;
  await deployElasticsearch(namespace, version, {
    heapSize: options.heapSize,
    nodeCount: options.nodeCount,
  });
  if (includeLogstash) {
    await deployLogstash(
      namespace,
      version,
      options.configString?.trim() || DEFAULT_LOGSTASH_CONFIG,
      { heapSize: options.lsHeapSize },
    );
  }
  await deployFleetServer(namespace, version);
}

export async function upgradeFleetServer(
  namespace: string,
  stackVersion: string,
): Promise<void> {
  await patchCustomObjectVersion({
    group: AGENT_GROUP,
    version: AGENT_API_VERSION,
    namespace,
    plural: "agents",
    name: FLEET_SERVER_NAME,
    stackVersion,
  });
}

export async function upgradeElasticAgent(
  namespace: string,
  stackVersion: string,
): Promise<void> {
  await patchCustomObjectVersion({
    group: AGENT_GROUP,
    version: AGENT_API_VERSION,
    namespace,
    plural: "agents",
    name: ELASTIC_AGENT_NAME,
    stackVersion,
  });
}

export async function upgradeAllQuickstart(
  namespace: string,
  stackVersion: string,
): Promise<{ upgraded: string[] }> {
  const upgraded: string[] = [];
  const es = await getElasticsearchStatus(namespace);
  if (es.exists) {
    await upgradeElasticsearch(namespace, stackVersion);
    upgraded.push("elasticsearch");
  }
  const kb = await getKibanaStatus(namespace);
  if (kb.exists) {
    await upgradeKibana(namespace, stackVersion);
    upgraded.push("kibana");
  }
  const ls = await getLogstashStatus(namespace);
  if (ls.exists) {
    await upgradeLogstash(namespace, stackVersion);
    upgraded.push("logstash");
  }
  const fleetServer = await getFleetServerStatus(namespace);
  if (fleetServer.exists) {
    await upgradeFleetServer(namespace, stackVersion);
    upgraded.push("fleet-server");
  }
  const elasticAgent = await getElasticAgentStatus(namespace);
  if (elasticAgent.exists) {
    await upgradeElasticAgent(namespace, stackVersion);
    upgraded.push("elastic-agent");
  }
  if (upgraded.length === 0) {
    const err = new Error(
      "No quickstart stack resources found to upgrade in this namespace.",
    ) as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }
  return { upgraded };
}

export function assertFleetExampleId(id: string): FleetExampleId {
  const found = FLEET_EXAMPLES.find((e) => e.id === id);
  if (!found) {
    const err = new Error(
      `Unknown Fleet example "${id}". Valid: ${FLEET_EXAMPLES.map((e) => e.id).join(", ")}`,
    ) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  return found.id;
}
