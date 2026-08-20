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
} from "./fleet.js";
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
  getCredentials,
  getEckLicenseStatus,
  getElasticsearchStatus,
  getErrorMessage,
  getKibanaStatus,
  getLogstashStatus,
  getPodLogs,
  normalizeHeapSize,
  normalizeNodeCount,
  startEckTrial,
  switchKubeContext,
} from "./k8s.js";
import {
  getPortForwardStatus,
  parseTarget,
  startPortForward,
  stopAllPortForwards,
  stopPortForward,
} from "./portforward.js";

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

const DEFAULT_VERSION = "9.5.0";
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

function heapSizeFromBody(body: unknown): string | undefined {
  if (
    typeof body === "object" &&
    body !== null &&
    "heapSize" in body &&
    typeof (body as { heapSize: unknown }).heapSize === "string"
  ) {
    return normalizeHeapSize((body as { heapSize: string }).heapSize);
  }
  return undefined;
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

app.get("/api/elastic-agent", async (req, reply) => {
  try {
    const namespace = namespaceFromQuery(req.query as Record<string, unknown>);
    return await getElasticAgentStatus(namespace);
  } catch (err) {
    reply.code(500);
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
  console.log(`ECKgui API listening on http://127.0.0.1:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
