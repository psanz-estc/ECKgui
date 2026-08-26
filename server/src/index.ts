import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  assertFleetExampleId,
  deleteElasticAgent,
  deleteFleetResources,
  deleteFleetServer,
  deployAllQuickstart,
  deployFleetPack,
  deployFleetServer,
  getElasticAgentStatus,
  getFleetServerStatus,
  listFleetExamples,
  upgradeAllQuickstart,
  upgradeElasticAgent,
  upgradeFleetServer,
} from "./fleet.js";
import {
  getEckApplyProgress,
  getEckOperatorStatus,
  installOrUpgradeEckOperator,
  listEckOperatorVersions,
  uninstallEckOperator,
} from "./eck.js";
import {
  DEFAULT_STACK_VERSION,
  listElasticStackVersions,
} from "./stack-versions.js";
import {
  createNamespace,
  deleteElasticsearch,
  deleteKibana,
  deleteLogstash,
  deleteNamespace,
  destroyQuickstart,
  deployElasticsearch,
  deployKibana,
  deployLogstash,
  getClusterInfo,
  getClusterMemory,
  getCredentials,
  getEckLicenseStatus,
  applyEckEnterpriseLicense,
  getElasticsearchStatus,
  getErrorMessage,
  getKibanaStatus,
  getLogstashStatus,
  getPodLogs,
  describePod,
  normalizeHeapSize,
  normalizeNodeCount,
  restartPods,
  startEckTrial,
  switchKubeContext,
  watchClusterMemory,
  upgradeElasticsearch,
  updateElasticsearchTopology,
  upgradeKibana,
  upgradeLogstash,
} from "./k8s.js";
import {
  getPortForwardStatus,
  parseTarget,
  startPortForward,
  stopAllPortForwards,
  stopPortForward,
} from "./portforward.js";
import { loadKubeConfig } from "./kubeconfig.js";

function statusFromError(err: unknown): number {
  if (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    typeof (err as { statusCode: unknown }).statusCode === "number"
  ) {
    return (err as { statusCode: number }).statusCode;
  }
  return 500;
}

const DEFAULT_VERSION = DEFAULT_STACK_VERSION;
const PORT = Number(process.env.PORT || 8787);

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: true,
});

function versionFromBody(body: unknown): string {
  const version =
    typeof body === "object" &&
    body !== null &&
    "version" in body &&
    typeof (body as { version: unknown }).version === "string"
      ? (body as { version: string }).version.trim()
      : "";
  if (!version) {
    const err = new Error("version is required") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  return version;
}

function configStringFromBody(body: unknown): string {
  const configString =
    typeof body === "object" &&
    body !== null &&
    "configString" in body &&
    typeof (body as { configString: unknown }).configString === "string"
      ? (body as { configString: string }).configString
      : "";
  if (!configString.trim()) {
    const err = new Error("configString is required") as Error & {
      statusCode: number;
    };
    err.statusCode = 400;
    throw err;
  }
  return configString;
}

function namespaceFromQuery(query: Record<string, unknown>): string {
  const ns =
    typeof query.namespace === "string" && query.namespace.trim()
      ? query.namespace.trim()
      : "default";
  return ns;
}

function heapSizeFieldFromBody(body: unknown): {
  provided: boolean;
  value?: string;
} {
  if (typeof body !== "object" || body === null || !("heapSize" in body)) {
    return { provided: false };
  }
  const raw = (body as { heapSize: unknown }).heapSize;
  if (raw == null || (typeof raw === "string" && !raw.trim())) {
    return { provided: true, value: undefined };
  }
  if (typeof raw !== "string") {
    const err = new Error(
      'Invalid heapSize. Use forms like "512m", "1g", or "2g".',
    ) as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  }
  return { provided: true, value: normalizeHeapSize(raw) };
}

function heapSizeFromBody(body: unknown): string | undefined {
  const field = heapSizeFieldFromBody(body);
  return field.provided ? field.value : undefined;
}

function lsHeapSizeFromBody(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.lsHeapSize === "string") {
    return normalizeHeapSize(record.lsHeapSize);
  }
  return undefined;
}

function nodeCountFromBody(body: unknown): number | undefined {
  if (typeof body !== "object" || body === null || !("nodeCount" in body)) {
    return undefined;
  }
  const raw = (body as { nodeCount: unknown }).nodeCount;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  return normalizeNodeCount(n);
}

function tailLinesFromQuery(query: Record<string, unknown>): number {
  const raw = query.tailLines;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  return 200;
}

app.get("/api/health", async () => ({ ok: true }));

app.get("/api/cluster", async (_req, reply) => {
  try {
    const info = await getClusterInfo();
    return { ...info, defaultVersion: DEFAULT_VERSION };
  } catch (err) {
    reply.code(500);
    return { error: getErrorMessage(err) };
  }
});

app.get("/api/cluster/memory", async (req, reply) => {
  reply.hijack();
  req.raw.setTimeout(0);
  reply.raw.setTimeout(0);
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const startedContext = loadKubeConfig().getCurrentContext();
  const abort = new AbortController();
  const writeEvent = (memory: Awaited<ReturnType<typeof getClusterMemory>>) => {
    if (reply.raw.writableEnded) return;
    reply.raw.write(`data: ${JSON.stringify(memory)}\n\n`);
  };

  try {
    writeEvent(await getClusterMemory());
  } catch {
    // Stream still useful once the watch or a later snapshot succeeds.
  }

  void watchClusterMemory(writeEvent, abort.signal).catch(() => undefined);

  const heartbeat = setInterval(() => {
    if (reply.raw.writableEnded) return;
    if (loadKubeConfig().getCurrentContext() !== startedContext) {
      abort.abort();
      clearInterval(heartbeat);
      reply.raw.end();
      return;
    }
    reply.raw.write(": ping\n\n");
  }, 15000);

  const close = () => {
    abort.abort();
    clearInterval(heartbeat);
    if (!reply.raw.writableEnded) reply.raw.end();
  };
  req.raw.on("close", close);
  req.raw.on("aborted", close);
});

app.post("/api/cluster/context", async (req, reply) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const context =
      typeof body.context === "string" ? body.context : "";
    switchKubeContext(context);
    await stopAllPortForwards();
    const info = await getClusterInfo();
    return { ...info, defaultVersion: DEFAULT_VERSION };
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.get("/api/eck/operator", async (_req, reply) => {
  try {
    return await getEckOperatorStatus();
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.get("/api/eck/operator/progress", async (_req, reply) => {
  try {
    return getEckApplyProgress();
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.get("/api/eck/operator/versions", async (_req, reply) => {
  try {
    return await listEckOperatorVersions();
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.get("/api/stack/versions", async (_req, reply) => {
  try {
    return await listElasticStackVersions();
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.post("/api/eck/operator", async (req, reply) => {
  try {
    const version = versionFromBody(req.body);
    return await installOrUpgradeEckOperator(version);
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.delete("/api/eck/operator", async (req, reply) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const query = req.query as Record<string, unknown>;
    const deleteCrds = body.deleteCrds === true || query.deleteCrds === "true";
    const version =
      typeof body.version === "string" && body.version.trim()
        ? body.version.trim()
        : undefined;
    return await uninstallEckOperator({ deleteCrds, version });
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.get("/api/eck/license", async (_req, reply) => {
  try {
    return await getEckLicenseStatus();
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.post("/api/eck/license/trial", async (req, reply) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const acceptEula = body.acceptEula === true;
    return await startEckTrial({ acceptEula });
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.post("/api/eck/license", async (req, reply) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const licenseJson =
      typeof body.licenseJson === "string" ? body.licenseJson : "";
    return await applyEckEnterpriseLicense(licenseJson);
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.post("/api/namespaces", async (req, reply) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name =
      typeof body.name === "string" ? body.name : "";
    const created = await createNamespace(name);
    const info = await getClusterInfo();
    return { name: created, ...info, defaultVersion: DEFAULT_VERSION };
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.delete("/api/namespaces/:name", async (req, reply) => {
  try {
    const name = decodeURIComponent((req.params as { name: string }).name);
    await deleteNamespace(name);
    await stopAllPortForwards();
    const info = await getClusterInfo();
    return { ok: true, deleted: name, ...info, defaultVersion: DEFAULT_VERSION };
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.get("/api/elasticsearch", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    return await getElasticsearchStatus(namespace);
  } catch (err) {
    reply.code(500);
    return { error: getErrorMessage(err) };
  }
});

app.post("/api/elasticsearch", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    const version = versionFromBody(req.body);
    const heapSize = heapSizeFromBody(req.body);
    const nodeCount = nodeCountFromBody(req.body);
    await deployElasticsearch(namespace, version, { heapSize, nodeCount });
    return await getElasticsearchStatus(namespace);
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.patch("/api/elasticsearch", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    const version =
      typeof req.body === "object" &&
      req.body !== null &&
      "version" in req.body &&
      typeof (req.body as { version: unknown }).version === "string"
        ? (req.body as { version: string }).version.trim()
        : "";
    const nodeCount = nodeCountFromBody(req.body);
    const heapField = heapSizeFieldFromBody(req.body);
    if (!version && nodeCount === undefined && !heapField.provided) {
      const err = new Error(
        "version, nodeCount, or heapSize is required",
      ) as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    }
    if (version) {
      await upgradeElasticsearch(namespace, version);
    }
    if (nodeCount !== undefined || heapField.provided) {
      await updateElasticsearchTopology(namespace, {
        nodeCount,
        heapSize: heapField.value,
        patchHeap: heapField.provided,
      });
    }
    return await getElasticsearchStatus(namespace);
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.get("/api/pods/:name/logs", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    const name = decodeURIComponent((req.params as { name: string }).name);
    const tailLines = tailLinesFromQuery(req.query as Record<string, unknown>);
    return await getPodLogs(namespace, name, tailLines);
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.get("/api/pods/:name/describe", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    const name = decodeURIComponent((req.params as { name: string }).name);
    return await describePod(namespace, name);
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.delete("/api/elasticsearch", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    await deleteElasticsearch(namespace);
    return { ok: true };
  } catch (err) {
    reply.code(500);
    return { error: getErrorMessage(err) };
  }
});

app.post("/api/elasticsearch/restart", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    return await restartPods(namespace, "elasticsearch");
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.get("/api/kibana", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    return await getKibanaStatus(namespace);
  } catch (err) {
    reply.code(500);
    return { error: getErrorMessage(err) };
  }
});

app.post("/api/kibana", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    const version = versionFromBody(req.body);
    await deployKibana(namespace, version);
    return await getKibanaStatus(namespace);
  } catch (err) {
    reply.code(500);
    return { error: getErrorMessage(err) };
  }
});

app.patch("/api/kibana", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    const version = versionFromBody(req.body);
    await upgradeKibana(namespace, version);
    return await getKibanaStatus(namespace);
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.delete("/api/kibana", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    await deleteKibana(namespace);
    return { ok: true };
  } catch (err) {
    reply.code(500);
    return { error: getErrorMessage(err) };
  }
});

app.post("/api/kibana/restart", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    return await restartPods(namespace, "kibana");
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.get("/api/credentials", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    return await getCredentials(namespace);
  } catch (err) {
    reply.code(500);
    return { error: getErrorMessage(err) };
  }
});

app.get("/api/logstash", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    return await getLogstashStatus(namespace);
  } catch (err) {
    reply.code(500);
    return { error: getErrorMessage(err) };
  }
});

app.post("/api/logstash", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    const version = versionFromBody(req.body);
    const configString = configStringFromBody(req.body);
    const heapSize =
      lsHeapSizeFromBody(req.body) ?? heapSizeFromBody(req.body);
    await deployLogstash(namespace, version, configString, { heapSize });
    return await getLogstashStatus(namespace);
  } catch (err) {
    const status =
      typeof err === "object" &&
      err !== null &&
      "statusCode" in err &&
      typeof (err as { statusCode: unknown }).statusCode === "number"
        ? (err as { statusCode: number }).statusCode
        : 500;
    reply.code(status);
    return { error: getErrorMessage(err) };
  }
});

app.patch("/api/logstash", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    const version = versionFromBody(req.body);
    await upgradeLogstash(namespace, version);
    return await getLogstashStatus(namespace);
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.delete("/api/logstash", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    await deleteLogstash(namespace);
    return { ok: true };
  } catch (err) {
    reply.code(500);
    return { error: getErrorMessage(err) };
  }
});

app.delete("/api/quickstart", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    await deleteFleetResources(namespace);
    await destroyQuickstart(namespace);
    await stopAllPortForwards();
    return { ok: true };
  } catch (err) {
    reply.code(500);
    return { error: getErrorMessage(err) };
  }
});

app.post("/api/quickstart/deploy-all", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const version = versionFromBody(body);
    const includeLogstash =
      typeof body.includeLogstash === "boolean" ? body.includeLogstash : true;
    const configString =
      typeof body.configString === "string" ? body.configString : undefined;
    const heapSize = heapSizeFromBody(body);
    const lsHeapSize = lsHeapSizeFromBody(body);
    const nodeCount = nodeCountFromBody(body);
    await deployAllQuickstart(namespace, version, {
      includeLogstash,
      configString,
      heapSize,
      lsHeapSize,
      nodeCount,
    });
    return { ok: true };
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.post("/api/quickstart/upgrade", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    const version = versionFromBody(req.body);
    const result = await upgradeAllQuickstart(namespace, version);
    return { ok: true, ...result };
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.get("/api/fleet/examples", async (_req, reply) => {
  try {
    return { examples: listFleetExamples() };
  } catch (err) {
    reply.code(500);
    return { error: getErrorMessage(err) };
  }
});

app.post("/api/fleet/example", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const version = versionFromBody(body);
    const exampleId = assertFleetExampleId(
      typeof body.exampleId === "string" ? body.exampleId : "",
    );
    await deployFleetPack(namespace, version, exampleId);
    return {
      ok: true,
      exampleId,
      fleetServer: await getFleetServerStatus(namespace),
      elasticAgent: await getElasticAgentStatus(namespace),
    };
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.get("/api/fleet-server", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    return await getFleetServerStatus(namespace);
  } catch (err) {
    reply.code(500);
    return { error: getErrorMessage(err) };
  }
});

app.post("/api/fleet-server", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    const version = versionFromBody(req.body);
    await deployFleetServer(namespace, version);
    return await getFleetServerStatus(namespace);
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.patch("/api/fleet-server", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    const version = versionFromBody(req.body);
    await upgradeFleetServer(namespace, version);
    return await getFleetServerStatus(namespace);
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.delete("/api/fleet-server", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    await deleteFleetServer(namespace);
    return { ok: true };
  } catch (err) {
    reply.code(500);
    return { error: getErrorMessage(err) };
  }
});

app.post("/api/fleet-server/restart", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    return await restartPods(namespace, "fleet-server");
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.get("/api/elastic-agent", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    return await getElasticAgentStatus(namespace);
  } catch (err) {
    reply.code(500);
    return { error: getErrorMessage(err) };
  }
});

app.patch("/api/elastic-agent", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    const version = versionFromBody(req.body);
    await upgradeElasticAgent(namespace, version);
    return await getElasticAgentStatus(namespace);
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.delete("/api/elastic-agent", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    await deleteElasticAgent(namespace);
    return { ok: true };
  } catch (err) {
    reply.code(500);
    return { error: getErrorMessage(err) };
  }
});

app.post("/api/elastic-agent/restart", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    return await restartPods(namespace, "elastic-agent");
  } catch (err) {
    reply.code(statusFromError(err));
    return { error: getErrorMessage(err) };
  }
});

app.get("/api/port-forward", async (_req, reply) => {
  try {
    return getPortForwardStatus();
  } catch (err) {
    reply.code(500);
    return { error: getErrorMessage(err) };
  }
});

app.post("/api/port-forward/:target", async (req, reply) => {
  try {
    const target = parseTarget((req.params as { target: string }).target);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const namespace =
      typeof body.namespace === "string" && body.namespace.trim()
        ? body.namespace.trim()
        : "default";
    return await startPortForward(target, namespace);
  } catch (err) {
    const status =
      typeof err === "object" &&
      err !== null &&
      "statusCode" in err &&
      typeof (err as { statusCode: unknown }).statusCode === "number"
        ? (err as { statusCode: number }).statusCode
        : 500;
    reply.code(status);
    return { error: getErrorMessage(err) };
  }
});

app.delete("/api/port-forward/:target", async (req, reply) => {
  try {
    const target = parseTarget((req.params as { target: string }).target);
    return await stopPortForward(target);
  } catch (err) {
    const status =
      typeof err === "object" &&
      err !== null &&
      "statusCode" in err &&
      typeof (err as { statusCode: unknown }).statusCode === "number"
        ? (err as { statusCode: number }).statusCode
        : 500;
    reply.code(status);
    return { error: getErrorMessage(err) };
  }
});

async function shutdown() {
  await stopAllPortForwards();
  await app.close();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

try {
  await app.listen({ port: PORT, host: "127.0.0.1" });
  console.log(`YAEU API listening on http://127.0.0.1:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
