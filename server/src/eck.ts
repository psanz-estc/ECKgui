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
const FIELD_MANAGER = "yaeu";
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

export type EckApplyProgress = {
  active: boolean;
  action: "install" | "uninstall" | null;
  version?: string;
  step: string;
  current?: { kind?: string; name?: string; namespace?: string };
  done: number;
  total: number;
};

const emptyApplyProgress = (): EckApplyProgress => ({
  active: false,
  action: null,
  step: "",
  done: 0,
  total: 0,
});

let applyProgress: EckApplyProgress = emptyApplyProgress();

export function getEckApplyProgress(): EckApplyProgress {
  return {
    ...applyProgress,
    current: applyProgress.current ? { ...applyProgress.current } : undefined,
  };
}

function setApplyProgress(partial: Partial<EckApplyProgress>) {
  applyProgress = { ...applyProgress, ...partial };
}

function objectRef(spec: KubernetesObject): {
  kind?: string;
  name?: string;
  namespace?: string;
} {
  return {
    kind: spec.kind,
    name: spec.metadata?.name,
    namespace: spec.metadata?.namespace,
  };
}

function objectLabel(spec: KubernetesObject): string {
  const kind = spec.kind || "object";
  const name = spec.metadata?.name || "";
  const ns = spec.metadata?.namespace;
  return ns ? `${kind} ${ns}/${name}` : `${kind} ${name}`.trim();
}

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
  const extracted = extractK8sStatusMessage(err);
  if (extracted) return extracted;
  return String(err);
}

function extractK8sStatusMessage(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const maybe = err as {
    body?: unknown;
    message?: string;
    response?: { body?: unknown };
  };

  const fromBody = (body: unknown): string | undefined => {
    if (typeof body === "string") {
      try {
        const parsed = JSON.parse(body) as { message?: unknown };
        if (typeof parsed.message === "string") return parsed.message;
      } catch {
        return body;
      }
    }
    if (typeof body === "object" && body !== null && "message" in body) {
      const message = (body as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
    return undefined;
  };

  const nested = fromBody(maybe.body) ?? fromBody(maybe.response?.body);
  if (nested) return nested;

  const raw = maybe.message;
  if (!raw) return undefined;
  const marker = "Unsuccessful HTTP Request Body:";
  const idx = raw.indexOf(marker);
  if (idx < 0) return raw;
  let jsonPart = raw.slice(idx + marker.length).trim();
  if (jsonPart.startsWith('"')) {
    try {
      jsonPart = JSON.parse(jsonPart) as string;
    } catch {
      jsonPart = jsonPart
        .replace(/^"/, "")
        .replace(/"\s*$/, "")
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"');
    }
  }
  try {
    const parsed = JSON.parse(jsonPart) as { message?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Keep the original client message.
  }
  return raw;
}

function isRbacPrivilegeEscalation(err: unknown): boolean {
  const message = extractK8sStatusMessage(err) ?? String(err);
  return message.includes(
    "attempting to grant RBAC permissions not currently held",
  );
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
      "User-Agent": "YAEU",
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

async function applyManifests(
  yaml: string,
  onEach?: (spec: KubernetesObject, index: number, total: number) => void,
): Promise<number> {
  const docs = parseManifests(yaml);
  const { objects } = clients();
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    onEach?.(doc, i, docs.length);
    await applyObject(objects, doc);
  }
  return docs.length;
}

async function deleteManifests(
  yaml: string,
  onEach?: (spec: KubernetesObject, index: number, total: number) => void,
): Promise<number> {
  const docs = parseManifests(yaml);
  const { objects } = clients();
  const reversed = [...docs].reverse();
  for (let i = 0; i < reversed.length; i++) {
    const doc = reversed[i];
    onEach?.(doc, i, reversed.length);
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
  setApplyProgress({
    active: true,
    action: "install",
    version: target,
    step: `Fetching ECK ${target} CRDs and operator YAML from download.elastic.co…`,
    current: undefined,
    done: 0,
    total: 0,
  });

  try {
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
      setApplyProgress({
        step: `Removing ECK operator ${uninstallVersion} before installing ${target}…`,
      });
      try {
        const previousOperator = await fetchText(
          manifestUrl(uninstallVersion, "operator.yaml"),
          60_000,
        );
        await deleteManifests(previousOperator, (spec) => {
          setApplyProgress({
            step: `Removing ${objectLabel(spec)}`,
            current: objectRef(spec),
          });
        });
      } catch (err) {
        throw httpError(
          `Could not remove ECK operator ${uninstallVersion} before installing ${target}: ${errorMessage(err)}`,
          502,
        );
      }
    }

    const crdDocs = parseManifests(crdsYaml);
    const operatorDocs = parseManifests(operatorYaml);
    const total = crdDocs.length + operatorDocs.length;
    let done = 0;
    setApplyProgress({
      step: `Applying ${crdDocs.length} CRDs, then the operator into elastic-system…`,
      done: 0,
      total,
    });

    const track = (spec: KubernetesObject, prefix: string) => {
      done += 1;
      setApplyProgress({
        step: `${prefix} ${objectLabel(spec)} (${done}/${total})`,
        current: objectRef(spec),
        done,
        total,
      });
    };

    try {
      await applyManifests(crdsYaml, (spec) => track(spec, "Applying CRD"));
      await applyManifests(operatorYaml, (spec) =>
        track(spec, "Applying operator"),
      );
    } catch (err) {
      if (isRbacPrivilegeEscalation(err)) {
        throw httpError(
          `Cannot install ECK ${target}: your Kubernetes user is not allowed to create ClusterRole "elastic-operator". The API server blocks granting RBAC permissions you do not already hold (privilege escalation prevention). On GKE, bind cluster-admin to your gcloud user (the ClusterRoleBinding name can be any unique value, for example cluster-pablo-admin-binding), then retry.`,
          403,
        );
      }
      throw httpError(
        `Failed to apply ECK ${target} manifests: ${errorMessage(err)}`,
        getStatusCode(err) || 502,
      );
    }

    setApplyProgress({
      step: "Waiting for the operator pod in elastic-system…",
      current: undefined,
      done: total,
      total,
    });
    await new Promise((r) => setTimeout(r, 1_500));
    return getEckOperatorStatus();
  } finally {
    setApplyProgress({
      ...applyProgress,
      active: false,
      current: undefined,
    });
  }
}

export async function uninstallEckOperator(options: {
  deleteCrds?: boolean;
  version?: string;
} = {}): Promise<EckOperatorStatus> {
  const status = await getEckOperatorStatus();
  const version = normalizeEckOperatorVersion(
    options.version || status.version || DEFAULT_ECK_OPERATOR_VERSION,
  );

  setApplyProgress({
    active: true,
    action: "uninstall",
    version,
    step: `Fetching ECK ${version} operator.yaml to delete its resources…`,
    current: undefined,
    done: 0,
    total: 0,
  });

  try {
    try {
      const operatorYaml = await fetchText(
        manifestUrl(version, "operator.yaml"),
        60_000,
      );
      await deleteManifests(operatorYaml, (spec, index, total) => {
        setApplyProgress({
          step: `Removing ${objectLabel(spec)} (${index + 1}/${total})`,
          current: objectRef(spec),
          done: index + 1,
          total,
        });
      });
    } catch (err) {
      throw httpError(
        `Failed to uninstall ECK operator ${version}: ${errorMessage(err)}`,
        getStatusCode(err) || 502,
      );
    }

    if (options.deleteCrds) {
      try {
        setApplyProgress({
          step: `Deleting ECK ${version} CRDs (this removes Elastic CRs cluster-wide)…`,
        });
        const crdsYaml = await fetchText(manifestUrl(version, "crds.yaml"), 60_000);
        await deleteManifests(crdsYaml, (spec, index, total) => {
          setApplyProgress({
            step: `Deleting CRD ${objectLabel(spec)} (${index + 1}/${total})`,
            current: objectRef(spec),
            done: index + 1,
            total,
          });
        });
      } catch (err) {
        throw httpError(
          `Operator removed, but deleting CRDs failed: ${errorMessage(err)}`,
          getStatusCode(err) || 502,
        );
      }
    }

    setApplyProgress({
      step: "Waiting for Kubernetes to finish removing operator resources…",
      current: undefined,
    });
    await new Promise((r) => setTimeout(r, 1_000));
    return getEckOperatorStatus();
  } finally {
    setApplyProgress({
      ...applyProgress,
      active: false,
      current: undefined,
    });
  }
}
