export type EckOperatorPhase =
  | "not_installed"
  | "installing"
  | "unhealthy"
  | "running";

export type EckOperatorStatus = {
  operatorNamespace: string;
  installed: boolean;
  ready: boolean;
  version?: string;
  phase: EckOperatorPhase;
  message?: string;
  podName?: string;
  podPhase?: string;
};

export type EckOperatorVersionList = {
  defaultVersion: string;
  versions: string[];
  source: "github" | "fallback";
};

export type EckApplyProgress = {
  active: boolean;
  action: "install" | "uninstall" | null;
  version?: string;
  step: string;
  current?: { kind?: string; name?: string; namespace?: string };
  done: number;
  total: number;
};

export type StackVersionList = {
  defaultVersion: string;
  versions: string[];
  source: "artifacts" | "github" | "fallback";
};

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
  defaultVersion: string;
  reachable: boolean;
  eckInstalled: boolean;
  eck: EckOperatorStatus;
  memory?: ClusterMemory;
  error?: string;
};

export type EckLicenseStatus = {
  operatorNamespace: string;
  level: string;
  trialSecretExists: boolean;
  canStartTrial: boolean;
  message?: string;
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
  error?: string;
};

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

export type Credentials = {
  user: string;
  password: string | null;
  portForwardEs: string;
  portForwardKibana: string;
  error?: string;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(url, {
    ...init,
    headers,
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok || data.error) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export function getCluster() {
  return request<ClusterInfo>("/api/cluster");
}

export function setClusterContext(context: string) {
  return request<ClusterInfo>("/api/cluster/context", {
    method: "POST",
    body: JSON.stringify({ context }),
  });
}

export function getEckOperator() {
  return request<EckOperatorStatus>("/api/eck/operator");
}

export function getEckApplyProgress() {
  return request<EckApplyProgress>("/api/eck/operator/progress");
}

export function getEckOperatorVersions() {
  return request<EckOperatorVersionList>("/api/eck/operator/versions");
}

export function getStackVersions() {
  return request<StackVersionList>("/api/stack/versions");
}

export function installEckOperator(version: string) {
  return request<EckOperatorStatus>("/api/eck/operator", {
    method: "POST",
    body: JSON.stringify({ version }),
  });
}

export function uninstallEckOperator(options: {
  deleteCrds?: boolean;
  version?: string;
} = {}) {
  return request<EckOperatorStatus>("/api/eck/operator", {
    method: "DELETE",
    body: JSON.stringify(options),
  });
}

export function getEckLicense() {
  return request<EckLicenseStatus>("/api/eck/license");
}

export function startEckTrialLicense() {
  return request<EckLicenseStatus>("/api/eck/license/trial", {
    method: "POST",
    body: JSON.stringify({ acceptEula: true }),
  });
}

export function applyEckEnterpriseLicense(licenseJson: string) {
  return request<EckLicenseStatus>("/api/eck/license", {
    method: "POST",
    body: JSON.stringify({ licenseJson }),
  });
}

export function createNamespace(name: string) {
  return request<ClusterInfo & { name: string }>("/api/namespaces", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function deleteNamespace(name: string) {
  return request<ClusterInfo & { ok: boolean; deleted: string }>(
    `/api/namespaces/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
}

export const PROTECTED_NAMESPACES = new Set([
  "default",
  "kube-system",
  "kube-public",
  "kube-node-lease",
  "elastic-system",
]);

export function getElasticsearch(namespace: string) {
  return request<ResourceStatus>(
    `/api/elasticsearch?namespace=${encodeURIComponent(namespace)}`,
  );
}

export function deployElasticsearch(
  namespace: string,
  version: string,
  options: { heapSize?: string; nodeCount?: number } = {},
) {
  const { heapSize, nodeCount } = options;
  return request<ResourceStatus>(
    `/api/elasticsearch?namespace=${encodeURIComponent(namespace)}`,
    {
      method: "POST",
      body: JSON.stringify({
        version,
        ...(heapSize?.trim() ? { heapSize: heapSize.trim() } : {}),
        ...(typeof nodeCount === "number" ? { nodeCount } : {}),
      }),
    },
  );
}

export function upgradeElasticsearch(namespace: string, version: string) {
  return request<ResourceStatus>(
    `/api/elasticsearch?namespace=${encodeURIComponent(namespace)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ version }),
    },
  );
}

export function updateElasticsearchTopology(
  namespace: string,
  options: { heapSize?: string; nodeCount: number },
) {
  const { heapSize, nodeCount } = options;
  return request<ResourceStatus>(
    `/api/elasticsearch?namespace=${encodeURIComponent(namespace)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        nodeCount,
        heapSize: heapSize?.trim() ?? "",
      }),
    },
  );
}

export function deleteElasticsearch(namespace: string) {
  return request<{ ok: boolean }>(
    `/api/elasticsearch?namespace=${encodeURIComponent(namespace)}`,
    { method: "DELETE" },
  );
}

export function getKibana(namespace: string) {
  return request<ResourceStatus>(
    `/api/kibana?namespace=${encodeURIComponent(namespace)}`,
  );
}

export function deployKibana(namespace: string, version: string) {
  return request<ResourceStatus>(
    `/api/kibana?namespace=${encodeURIComponent(namespace)}`,
    {
      method: "POST",
      body: JSON.stringify({ version }),
    },
  );
}

export function upgradeKibana(namespace: string, version: string) {
  return request<ResourceStatus>(
    `/api/kibana?namespace=${encodeURIComponent(namespace)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ version }),
    },
  );
}

export function deleteKibana(namespace: string) {
  return request<{ ok: boolean }>(
    `/api/kibana?namespace=${encodeURIComponent(namespace)}`,
    { method: "DELETE" },
  );
}

export function getLogstash(namespace: string) {
  return request<ResourceStatus>(
    `/api/logstash?namespace=${encodeURIComponent(namespace)}`,
  );
}

export function deployLogstash(
  namespace: string,
  version: string,
  configString: string,
  options: { heapSize?: string } = {},
) {
  const { heapSize } = options;
  return request<ResourceStatus>(
    `/api/logstash?namespace=${encodeURIComponent(namespace)}`,
    {
      method: "POST",
      body: JSON.stringify({
        version,
        configString,
        ...(heapSize?.trim() ? { lsHeapSize: heapSize.trim() } : {}),
      }),
    },
  );
}

export function deleteLogstash(namespace: string) {
  return request<{ ok: boolean }>(
    `/api/logstash?namespace=${encodeURIComponent(namespace)}`,
    { method: "DELETE" },
  );
}

export function upgradeLogstash(namespace: string, version: string) {
  return request<ResourceStatus>(
    `/api/logstash?namespace=${encodeURIComponent(namespace)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ version }),
    },
  );
}

export function destroyQuickstart(namespace: string) {
  return request<{ ok: boolean }>(
    `/api/quickstart?namespace=${encodeURIComponent(namespace)}`,
    { method: "DELETE" },
  );
}

export function deployAllQuickstart(
  namespace: string,
  version: string,
  options: {
    includeLogstash?: boolean;
    configString?: string;
    heapSize?: string;
    lsHeapSize?: string;
    nodeCount?: number;
  } = {},
) {
  const { heapSize, lsHeapSize, nodeCount, ...rest } = options;
  return request<{ ok: boolean }>(
    `/api/quickstart/deploy-all?namespace=${encodeURIComponent(namespace)}`,
    {
      method: "POST",
      body: JSON.stringify({
        version,
        ...rest,
        ...(heapSize?.trim() ? { heapSize: heapSize.trim() } : {}),
        ...(lsHeapSize?.trim() ? { lsHeapSize: lsHeapSize.trim() } : {}),
        ...(typeof nodeCount === "number" ? { nodeCount } : {}),
      }),
    },
  );
}

export function upgradeAllQuickstart(namespace: string, version: string) {
  return request<{ ok: boolean; upgraded: string[] }>(
    `/api/quickstart/upgrade?namespace=${encodeURIComponent(namespace)}`,
    {
      method: "POST",
      body: JSON.stringify({ version }),
    },
  );
}

export function getPodLogs(
  namespace: string,
  name: string,
  tailLines = 200,
) {
  const params = new URLSearchParams({
    namespace,
    tailLines: String(tailLines),
  });
  return request<{
    name: string;
    namespace: string;
    tailLines: number;
    logs: string;
  }>(`/api/pods/${encodeURIComponent(name)}/logs?${params.toString()}`);
}

export function getPodDescribe(namespace: string, name: string) {
  const params = new URLSearchParams({ namespace });
  return request<{
    name: string;
    namespace: string;
    describe: string;
  }>(`/api/pods/${encodeURIComponent(name)}/describe?${params.toString()}`);
}

export type FleetExampleMeta = {
  id: string;
  name: string;
  description: string;
  note?: string;
};

export function getFleetExamples() {
  return request<{ examples: FleetExampleMeta[] }>("/api/fleet/examples");
}

export function deployFleetExample(
  namespace: string,
  version: string,
  exampleId: string,
) {
  return request<{ ok: boolean; exampleId: string }>(
    `/api/fleet/example?namespace=${encodeURIComponent(namespace)}`,
    {
      method: "POST",
      body: JSON.stringify({ version, exampleId }),
    },
  );
}

export function getFleetServer(namespace: string) {
  return request<ResourceStatus>(
    `/api/fleet-server?namespace=${encodeURIComponent(namespace)}`,
  );
}

export function deployFleetServer(namespace: string, version: string) {
  return request<ResourceStatus>(
    `/api/fleet-server?namespace=${encodeURIComponent(namespace)}`,
    {
      method: "POST",
      body: JSON.stringify({ version }),
    },
  );
}

export function upgradeFleetServer(namespace: string, version: string) {
  return request<ResourceStatus>(
    `/api/fleet-server?namespace=${encodeURIComponent(namespace)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ version }),
    },
  );
}

export function deleteFleetServer(namespace: string) {
  return request<{ ok: boolean }>(
    `/api/fleet-server?namespace=${encodeURIComponent(namespace)}`,
    { method: "DELETE" },
  );
}

export function getElasticAgent(namespace: string) {
  return request<ResourceStatus>(
    `/api/elastic-agent?namespace=${encodeURIComponent(namespace)}`,
  );
}

export function upgradeElasticAgent(namespace: string, version: string) {
  return request<ResourceStatus>(
    `/api/elastic-agent?namespace=${encodeURIComponent(namespace)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ version }),
    },
  );
}

export function deleteElasticAgent(namespace: string) {
  return request<{ ok: boolean }>(
    `/api/elastic-agent?namespace=${encodeURIComponent(namespace)}`,
    { method: "DELETE" },
  );
}

export type RestartableResource =
  | "elasticsearch"
  | "kibana"
  | "fleet-server"
  | "elastic-agent";

export function restartInstance(
  resource: RestartableResource,
  namespace: string,
) {
  return request<{ deleted: string[] }>(
    `/api/${resource}/restart?namespace=${encodeURIComponent(namespace)}`,
    { method: "POST" },
  );
}

export function getCredentials(namespace: string) {
  return request<Credentials>(
    `/api/credentials?namespace=${encodeURIComponent(namespace)}`,
  );
}

export type PortForwardState = {
  target: string;
  status: "running" | "stopped" | "error";
  namespace: string | null;
  localPort: number;
  service: string;
  pid: number | null;
  message: string | null;
};

export type PortForwardStatus = {
  es: PortForwardState;
  kibana: PortForwardState;
  extras: PortForwardState[];
};

export function getPortForwards() {
  return request<PortForwardStatus>("/api/port-forward");
}

export function startPortForward(target: string, namespace: string) {
  return request<PortForwardState>(
    `/api/port-forward/${encodeURIComponent(target)}`,
    {
      method: "POST",
      body: JSON.stringify({ namespace }),
    },
  );
}

export function stopPortForward(target: string) {
  return request<PortForwardState>(
    `/api/port-forward/${encodeURIComponent(target)}`,
    {
      method: "DELETE",
    },
  );
}

export function findPortForwardState(
  status: PortForwardStatus,
  target: string,
): PortForwardState | undefined {
  if (target === "es") return status.es;
  if (target === "kibana") return status.kibana;
  return status.extras.find((item) => item.target === target);
}
