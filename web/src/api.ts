export type ClusterInfo = {
  context: string;
  server: string;
  namespaces: string[];
  defaultVersion: string;
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

export function getElasticsearch(namespace: string) {
  return request<ResourceStatus>(
    `/api/elasticsearch?namespace=${encodeURIComponent(namespace)}`,
  );
}

export function deployElasticsearch(namespace: string, version: string) {
  return request<ResourceStatus>(
    `/api/elasticsearch?namespace=${encodeURIComponent(namespace)}`,
    {
      method: "POST",
      body: JSON.stringify({ version }),
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
) {
  return request<ResourceStatus>(
    `/api/logstash?namespace=${encodeURIComponent(namespace)}`,
    {
      method: "POST",
      body: JSON.stringify({ version, configString }),
    },
  );
}

export function deleteLogstash(namespace: string) {
  return request<{ ok: boolean }>(
    `/api/logstash?namespace=${encodeURIComponent(namespace)}`,
    { method: "DELETE" },
  );
}

export function destroyQuickstart(namespace: string) {
  return request<{ ok: boolean }>(
    `/api/quickstart?namespace=${encodeURIComponent(namespace)}`,
    { method: "DELETE" },
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
