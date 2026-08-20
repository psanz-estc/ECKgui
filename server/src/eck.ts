import * as k8s from "@kubernetes/client-node";
import {
  KubernetesObjectApi,
  PatchStrategy,
  loadAllYaml,
  type KubernetesObject,
} from "@kubernetes/client-node";
import { loadKubeConfig } from "./kubeconfig.js";

export const ECK_OPERATOR_NAMESPACE = "elastic-system";
export const DEFAULT_ECK_OPERATOR_VERSION = "3.5.0";
export const ES_CRD_NAME = "elasticsearches.elasticsearch.k8s.elastic.co";

const OPERATOR_NAME = "elastic-operator";
const OPERATOR_LABEL = "control-plane=elastic-operator";
const FIELD_MANAGER = "eckgui";
const VERSION_RE = /^\d+\.\d+\.\d+([+.-][A-Za-z0-9.]+)?$/;
const FALLBACK_ECK_VERSIONS = [
  "3.5.0",
  "3.4.1",
  "3.3.1",
  "3.2.0",
  "2.16.1",
];

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

function clients() {
  const kc = loadKubeConfig();
  return {
    kc,
    core: kc.makeApiClient(k8s.CoreV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
    apiextensions: kc.makeApiClient(k8s.ApiextensionsV1Api),
    objects: KubernetesObjectApi.makeApiClient(kc),
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

function errorMessage(err: unknown): string {
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

function httpError(message: string, statusCode: number): Error & {
  statusCode: number;
} {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

export function normalizeEckOperatorVersion(raw: string): string {
  const version = raw.trim().replace(/^v/i, "");
  if (!VERSION_RE.test(version)) {
    throw httpError(
      "Invalid ECK operator version. Use a release like 3.5.0.",
      400,
    );
  }
  return version;
}

export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/i, "")
      .split("-")[0]
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function emptyEckOperatorStatus(
  message?: string,
): EckOperatorStatus {
  return {
    operatorNamespace: ECK_OPERATOR_NAMESPACE,
    installed: false,
    ready: false,
    phase: "not_installed",
    message,
  };
}

function imageVersion(image?: string): string | undefined {
  if (!image) return undefined;
  const withoutDigest = image.split("@")[0];
  const tag = withoutDigest.split(":").pop()?.trim();
  if (!tag || tag === "latest") return undefined;
  return tag.replace(/^v/i, "");
}

async function crdInstalled(): Promise<boolean> {
  try {
    const { apiextensions } = clients();
    await apiextensions.readCustomResourceDefinition({ name: ES_CRD_NAME });
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

function podIsReady(pod: k8s.V1Pod): boolean {
  if ((pod.status?.phase || "").toLowerCase() !== "running") return false;
  const containers = pod.status?.containerStatuses ?? [];
  return containers.length > 0 && containers.every((c) => c.ready);
}

function podIsStarting(pod: k8s.V1Pod): boolean {
  const phase = (pod.status?.phase || "").toLowerCase();
  return phase === "pending" || phase === "containercreating";
}

export async function getEckOperatorStatus(): Promise<EckOperatorStatus> {
  let installed = false;
  try {
    installed = await crdInstalled();
  } catch (err) {
    return emptyEckOperatorStatus(errorMessage(err));
  }

  let version: string | undefined;
  let pod: k8s.V1Pod | undefined;

  try {
    const { apps } = clients();
    const sts = await apps.readNamespacedStatefulSet({
      name: OPERATOR_NAME,
      namespace: ECK_OPERATOR_NAMESPACE,
    });
    const container = sts.spec?.template?.spec?.containers?.find(
      (c) => c.name === "manager" || c.name === OPERATOR_NAME,
    );
    version = imageVersion(
      container?.image || sts.spec?.template?.spec?.containers?.[0]?.image,
    );
  } catch (err) {
    if (!isNotFound(err)) {
      return {
        ...emptyEckOperatorStatus(errorMessage(err)),
        installed,
      };
    }
  }

  try {
    const { core } = clients();
    const listed = await core.listNamespacedPod({
      namespace: ECK_OPERATOR_NAMESPACE,
      labelSelector: OPERATOR_LABEL,
    });
    const items = listed.items ?? [];
    pod =
      items.find((p) => p.metadata?.name?.startsWith(`${OPERATOR_NAME}-`)) ||
      items[0];
  } catch (err) {
    if (!isNotFound(err)) {
      return {
        operatorNamespace: ECK_OPERATOR_NAMESPACE,
        installed,
        ready: false,
        version,
        phase: installed ? "unhealthy" : "not_installed",
        message: errorMessage(err),
      };
    }
  }

  if (!version && pod) {
    version = imageVersion(pod.spec?.containers?.[0]?.image);
  }

  const podName = pod?.metadata?.name;
  const podPhase = pod?.status?.phase;
  const ready = Boolean(pod && podIsReady(pod));

  if (ready) {
    return {
      operatorNamespace: ECK_OPERATOR_NAMESPACE,
      installed: true,
      ready: true,
      version,
      phase: "running",
      podName,
      podPhase,
      message: version
        ? `ECK operator ${version} is running.`
        : "ECK operator is running.",
    };
  }

  if (pod && podIsStarting(pod)) {
    return {
      operatorNamespace: ECK_OPERATOR_NAMESPACE,
      installed: installed || true,
      ready: false,
      version,
      phase: "installing",
      podName,
      podPhase,
      message: "ECK operator pod is starting.",
    };
  }

  if (pod) {
    return {
      operatorNamespace: ECK_OPERATOR_NAMESPACE,
      installed: true,
      ready: false,
      version,
      phase: "unhealthy",
      podName,
      podPhase,
      message: `ECK operator pod is ${podPhase || "not ready"}.`,
    };
  }

  if (installed) {
    return {
      operatorNamespace: ECK_OPERATOR_NAMESPACE,
      installed: true,
      ready: false,
      version,
      phase: "unhealthy",
      message:
        "Elasticsearch CRD is installed, but the operator pod is not running in elastic-system.",
    };
  }

  return emptyEckOperatorStatus("ECK operator is not installed.");
}

function manifestUrl(version: string, file: "crds.yaml" | "operator.yaml") {
  return `https://download.elastic.co/downloads/eck/${version}/${file}`;
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, {
    headers: {
      Accept: "application/yaml, text/plain, application/json, */*",
      "User-Agent": "ECKgui",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw httpError(
      `Failed to fetch ${url} (${res.status} ${res.statusText})`,
      res.status >= 400 && res.status < 600 ? res.status : 502,
    );
  }
  return await res.text();
}

function parseManifests(yaml: string): KubernetesObject[] {
  const docs = loadAllYaml(yaml) ?? [];
  return docs.filter((doc): doc is KubernetesObject => {
    if (!doc || typeof doc !== "object") return false;
    const obj = doc as KubernetesObject;
    return Boolean(obj.kind && obj.metadata?.name);
  });
}

async function applyObject(
  client: KubernetesObjectApi,
  spec: KubernetesObject,
): Promise<void> {
  const name = spec.metadata?.name || "";
  const header = {
    apiVersion: spec.apiVersion || "v1",
    kind: spec.kind,
    metadata: {
      name,
      namespace: spec.metadata?.namespace,
    },
  };

  try {
    await client.create(spec);
    return;
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
  }

  try {
    const current = await client.read(header);
    await client.replace({
      ...spec,
      metadata: {
        ...spec.metadata,
        name: spec.metadata?.name,
        namespace: spec.metadata?.namespace,
        resourceVersion: current.metadata?.resourceVersion,
      },
    });
    return;
  } catch {
    await client.patch(
      spec,
      undefined,
      undefined,
      FIELD_MANAGER,
      true,
      PatchStrategy.ServerSideApply,
    );
  }
}

async function deleteObject(
  client: KubernetesObjectApi,
  spec: KubernetesObject,
): Promise<void> {
  try {
    await client.delete({
      apiVersion: spec.apiVersion || "v1",
      kind: spec.kind,
      metadata: {
        name: spec.metadata?.name || "",
        namespace: spec.metadata?.namespace,
      },
    });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

async function applyManifests(yaml: string): Promise<number> {
  const docs = parseManifests(yaml);
  const { objects } = clients();
  for (const doc of docs) {
    await applyObject(objects, doc);
  }
  return docs.length;
}

async function deleteManifests(yaml: string): Promise<number> {
  const docs = parseManifests(yaml);
  const { objects } = clients();
  for (const doc of [...docs].reverse()) {
    await deleteObject(objects, doc);
  }
  return docs.length;
}

export async function listEckOperatorVersions(): Promise<EckOperatorVersionList> {
  try {
    const raw = await fetchText(
      "https://api.github.com/repos/elastic/cloud-on-k8s/releases?per_page=40",
      8_000,
    );
    const parsed = JSON.parse(raw) as Array<{
      tag_name?: string;
      draft?: boolean;
      prerelease?: boolean;
    }>;
    const versions = [
      ...new Set(
        parsed
          .filter((r) => r && !r.draft && !r.prerelease && r.tag_name)
          .map((r) => r.tag_name!.replace(/^v/i, ""))
          .filter((v) => VERSION_RE.test(v)),
      ),
    ];
    if (versions.length === 0) {
      return {
        defaultVersion: DEFAULT_ECK_OPERATOR_VERSION,
        versions: FALLBACK_ECK_VERSIONS,
        source: "fallback",
      };
    }
    if (!versions.includes(DEFAULT_ECK_OPERATOR_VERSION)) {
      versions.unshift(DEFAULT_ECK_OPERATOR_VERSION);
    }
    return {
      defaultVersion: DEFAULT_ECK_OPERATOR_VERSION,
      versions,
      source: "github",
    };
  } catch {
    return {
      defaultVersion: DEFAULT_ECK_OPERATOR_VERSION,
      versions: FALLBACK_ECK_VERSIONS,
      source: "fallback",
    };
  }
}

export async function installOrUpgradeEckOperator(
  version: string,
): Promise<EckOperatorStatus> {
  const target = normalizeEckOperatorVersion(version);
  const current = await getEckOperatorStatus();

  const [crdsYaml, operatorYaml] = await Promise.all([
    fetchText(manifestUrl(target, "crds.yaml"), 60_000),
    fetchText(manifestUrl(target, "operator.yaml"), 60_000),
  ]);

  const currentVersion = current.version;
  const isDowngrade =
    Boolean(currentVersion) && compareVersions(target, currentVersion!) < 0;

  if (isDowngrade && (current.installed || current.podName || current.version)) {
    const uninstallVersion = currentVersion || target;
    try {
      const previousOperator = await fetchText(
        manifestUrl(uninstallVersion, "operator.yaml"),
        60_000,
      );
      await deleteManifests(previousOperator);
    } catch (err) {
      throw httpError(
        `Could not remove ECK operator ${uninstallVersion} before installing ${target}: ${errorMessage(err)}`,
        502,
      );
    }
  }

  try {
    await applyManifests(crdsYaml);
    await applyManifests(operatorYaml);
  } catch (err) {
    throw httpError(
      `Failed to apply ECK ${target} manifests: ${errorMessage(err)}`,
      getStatusCode(err) || 502,
    );
  }

  await new Promise((r) => setTimeout(r, 1_500));
  return getEckOperatorStatus();
}

export async function uninstallEckOperator(options: {
  deleteCrds?: boolean;
  version?: string;
} = {}): Promise<EckOperatorStatus> {
  const status = await getEckOperatorStatus();
  const version = normalizeEckOperatorVersion(
    options.version || status.version || DEFAULT_ECK_OPERATOR_VERSION,
  );

  try {
    const operatorYaml = await fetchText(
      manifestUrl(version, "operator.yaml"),
      60_000,
    );
    await deleteManifests(operatorYaml);
  } catch (err) {
    throw httpError(
      `Failed to uninstall ECK operator ${version}: ${errorMessage(err)}`,
      getStatusCode(err) || 502,
    );
  }

  if (options.deleteCrds) {
    try {
      const crdsYaml = await fetchText(manifestUrl(version, "crds.yaml"), 60_000);
      await deleteManifests(crdsYaml);
    } catch (err) {
      throw httpError(
        `Operator removed, but deleting CRDs failed: ${errorMessage(err)}`,
        getStatusCode(err) || 502,
      );
    }
  }

  await new Promise((r) => setTimeout(r, 1_000));
  return getEckOperatorStatus();
}
