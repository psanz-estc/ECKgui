import * as k8s from "@kubernetes/client-node";
import { compareVersions, getEckOperatorStatus } from "./eck.js";
import { loadKubeConfig } from "./kubeconfig.js";

const SCP_GROUP = "stackconfigpolicy.k8s.elastic.co";
const SCP_VERSION = "v1alpha1";
const SCP_PLURAL = "stackconfigpolicies";
export const STACK_CONFIG_POLICY_NAME = "quickstart";
const MIN_ECK = "2.6.0";

type CustomApi = {
  createNamespacedCustomObject: (p: Record<string, unknown>) => Promise<unknown>;
  replaceNamespacedCustomObject: (p: Record<string, unknown>) => Promise<unknown>;
  deleteNamespacedCustomObject: (p: Record<string, unknown>) => Promise<unknown>;
  getNamespacedCustomObject: (p: Record<string, unknown>) => Promise<unknown>;
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

function policyBody(namespace: string): Record<string, unknown> {
  return {
    apiVersion: `${SCP_GROUP}/${SCP_VERSION}`,
    kind: "StackConfigPolicy",
    metadata: { name: STACK_CONFIG_POLICY_NAME, namespace },
    spec: {
      elasticsearch: {
        config: {
          "logger.level": "INFO",
        },
        clusterSettings: {
          "indices.recovery.max_bytes_per_sec": "100mb",
        },
        indexTemplates: {
          composableIndexTemplates: {
            "lab-logs": {
              index_patterns: ["lab-logs-*"],
              priority: 100,
              template: {
                mappings: {
                  properties: {
                    "@timestamp": { type: "date" },
                    message: { type: "text" },
                  },
                },
                settings: { number_of_shards: 1, number_of_replicas: 0 },
              },
            },
          },
        },
      },
    },
  };
}

export type StackConfigPolicyStatus = {
  name: string;
  exists: boolean;
  phase?: string;
  readyCount?: string;
  message?: string;
};

export async function getStackConfigPolicy(
  namespace: string,
): Promise<StackConfigPolicyStatus> {
  const { custom } = clients();
  try {
    const obj = (await custom.getNamespacedCustomObject({
      group: SCP_GROUP,
      version: SCP_VERSION,
      name: STACK_CONFIG_POLICY_NAME,
      namespace,
      plural: SCP_PLURAL,
    })) as Record<string, unknown>;
    const status = (obj.status ?? {}) as Record<string, unknown>;
    return {
      name: STACK_CONFIG_POLICY_NAME,
      exists: true,
      phase: status.phase ? String(status.phase) : undefined,
      readyCount: status.readyCount ? String(status.readyCount) : undefined,
    };
  } catch (err) {
    if (isNotFound(err)) {
      return { name: STACK_CONFIG_POLICY_NAME, exists: false };
    }
    throw err;
  }
}

export async function deployStackConfigPolicy(
  namespace: string,
): Promise<StackConfigPolicyStatus> {
  const eck = await getEckOperatorStatus();
  const eckVersion = eck.version?.trim();
  if (!eck.installed || !eckVersion) {
    throw httpError("ECK operator is not installed. Install it first.", 400);
  }
  if (compareVersions(eckVersion, MIN_ECK) < 0) {
    throw httpError(
      `StackConfigPolicy requires ECK ${MIN_ECK}+. Current ECK: ${eckVersion}.`,
      400,
    );
  }

  const { custom } = clients();
  const body = policyBody(namespace);
  try {
    await custom.createNamespacedCustomObject({
      group: SCP_GROUP,
      version: SCP_VERSION,
      namespace,
      plural: SCP_PLURAL,
      body,
    });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    const current = (await custom.getNamespacedCustomObject({
      group: SCP_GROUP,
      version: SCP_VERSION,
      namespace,
      plural: SCP_PLURAL,
      name: STACK_CONFIG_POLICY_NAME,
    })) as { metadata?: { resourceVersion?: string } };
    await custom.replaceNamespacedCustomObject({
      group: SCP_GROUP,
      version: SCP_VERSION,
      name: STACK_CONFIG_POLICY_NAME,
      namespace,
      plural: SCP_PLURAL,
      body: {
        ...body,
        metadata: {
          ...(body.metadata as object),
          resourceVersion: current.metadata?.resourceVersion,
        },
      },
    });
  }

  return getStackConfigPolicy(namespace);
}

export async function deleteStackConfigPolicy(namespace: string): Promise<void> {
  const { custom } = clients();
  try {
    await custom.deleteNamespacedCustomObject({
      group: SCP_GROUP,
      version: SCP_VERSION,
      name: STACK_CONFIG_POLICY_NAME,
      namespace,
      plural: SCP_PLURAL,
    });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}
