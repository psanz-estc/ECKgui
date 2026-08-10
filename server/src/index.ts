import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  deleteElasticsearch,
  deleteKibana,
  deleteLogstash,
  destroyQuickstart,
  deployElasticsearch,
  deployKibana,
  deployLogstash,
  getClusterInfo,
  getCredentials,
  getElasticsearchStatus,
  getErrorMessage,
  getKibanaStatus,
  getLogstashStatus,
} from "./k8s.js";
import {
  getPortForwardStatus,
  parseTarget,
  startPortForward,
  stopAllPortForwards,
  stopPortForward,
} from "./portforward.js";

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
    await deployElasticsearch(namespace, version);
    return await getElasticsearchStatus(namespace);
  } catch (err) {
    reply.code(500);
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
    await deployLogstash(namespace, version, configString);
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
    await destroyQuickstart(namespace);
    await stopAllPortForwards();
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
