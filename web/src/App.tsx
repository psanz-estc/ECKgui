import { useEffect, useState } from "react";
import {
  DEFAULT_LOGSTASH_CONFIG,
  deleteElasticsearch,
  deleteKibana,
  deleteLogstash,
  deployElasticsearch,
  deployKibana,
  deployLogstash,
  getCluster,
  getCredentials,
  getElasticsearch,
  getKibana,
  getLogstash,
  getPortForwards,
  startPortForward,
  stopPortForward,
  type ClusterInfo,
  type Credentials,
  type PortForwardState,
  type PortForwardStatus,
  type PortForwardTarget,
  type ResourceStatus,
} from "./api";

const emptyStatus = (): ResourceStatus => ({
  name: "quickstart",
  exists: false,
  pods: [],
});

const emptyPortForward = (
  target: PortForwardTarget,
  localPort: number,
  service: string,
): PortForwardState => ({
  target,
  status: "stopped",
  namespace: null,
  localPort,
  service,
  pid: null,
  message: null,
});

function overallBadge(es: ResourceStatus, kb: ResourceStatus, ls: ResourceStatus) {
  const resources = [es, kb, ls].filter((r) => r.exists);
  if (resources.length === 0) {
    return { label: "Empty", className: "missing" };
  }
  const healths = resources.map((r) => (r.health || "").toLowerCase());
  if (healths.some((h) => h === "red")) {
    return { label: "Unhealthy", className: "unhealthy" };
  }
  if (healths.every((h) => h === "green")) {
    return { label: "Healthy", className: "healthy" };
  }
  if (
    healths.some((h) => h === "yellow") &&
    healths.every((h) => h === "green" || h === "yellow")
  ) {
    return { label: "Yellow", className: "pending" };
  }
  if (
    resources.every((r) => {
      const phase = (r.phase || "").toLowerCase();
      return (
        phase === "ready" ||
        (r.pods.length > 0 && r.pods.every((p) => p.phase === "Running"))
      );
    })
  ) {
    return { label: "Healthy", className: "healthy" };
  }
  return { label: "Pending", className: "pending" };
}

function healthClass(status: ResourceStatus) {
  const h = (status.health || "").toLowerCase();
  if (h === "green") return "green";
  if (h === "yellow") return "yellow";
  if (h === "red") return "red";
  const phase = (status.phase || "").toLowerCase();
  if (phase === "ready") return "green";
  return "";
}

function badgeClassForStatus(status: ResourceStatus) {
  const cls = healthClass(status);
  if (cls === "green") return "healthy";
  if (cls === "red") return "unhealthy";
  if (cls === "yellow") return "pending";
  return "pending";
}

export default function App() {
  const [cluster, setCluster] = useState<ClusterInfo | null>(null);
  const [namespace, setNamespace] = useState("default");
  const [version, setVersion] = useState("9.5.0");
  const [es, setEs] = useState<ResourceStatus>(emptyStatus());
  const [kb, setKb] = useState<ResourceStatus>(emptyStatus());
  const [ls, setLs] = useState<ResourceStatus>(emptyStatus());
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [portForwards, setPortForwards] = useState<PortForwardStatus>({
    es: emptyPortForward("es", 9200, "quickstart-es-http"),
    kibana: emptyPortForward("kibana", 5601, "quickstart-kb-http"),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [accessOpen, setAccessOpen] = useState(false);
  const [logstashModalOpen, setLogstashModalOpen] = useState(false);
  const [logstashConfig, setLogstashConfig] = useState(DEFAULT_LOGSTASH_CONFIG);

  async function refreshPortForwards() {
    const status = await getPortForwards();
    setPortForwards(status);
  }

  async function refreshAll(ns = namespace) {
    const [esStatus, kbStatus, lsStatus, credentials, pfStatus] =
      await Promise.all([
        getElasticsearch(ns),
        getKibana(ns),
        getLogstash(ns),
        getCredentials(ns),
        getPortForwards(),
      ]);
    setEs(esStatus);
    setKb(kbStatus);
    setLs(lsStatus);
    setCreds(credentials);
    setPortForwards(pfStatus);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await getCluster();
        if (cancelled) return;
        setCluster(info);
        setVersion(info.defaultVersion);
        const ns = info.namespaces.includes("default")
          ? "default"
          : info.namespaces[0] || "default";
        setNamespace(ns);
        await refreshAll(ns);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!cluster) return;
    const id = window.setInterval(() => {
      refreshAll().catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
    }, 5000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cluster, namespace]);

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await action();
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function runPortForward(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await action();
      await refreshPortForwards();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refreshPortForwards().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  }

  function openLogstashModal() {
    setLogstashConfig(ls.configString?.trim() || DEFAULT_LOGSTASH_CONFIG);
    setLogstashModalOpen(true);
  }

  const badge = overallBadge(es, kb, ls);
  const deployedVersion = es.version || kb.version || ls.version || version;
  const hasInstances = es.exists || kb.exists || ls.exists;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-brand">ECKgui</div>
        <div className="topbar-meta" title={cluster?.server}>
          {cluster?.context || "loading…"}
        </div>
      </header>

      <main className="page">
        <p className="crumbs">
          Elastic Cloud on Kubernetes / <span>quickstart</span>
        </p>

        <section className="deploy-header">
          <div className="deploy-title">
            <h1>
              quickstart
              <span className={`badge ${badge.className}`}>{badge.label}</span>
            </h1>
            <p className="subtitle">
              Namespace {namespace} · Stack {deployedVersion} · ECK quickstart
            </p>
          </div>
          <div className="header-actions">
            <button
              className="ghost"
              disabled={Boolean(busy)}
              onClick={() => run("refresh", async () => refreshAll())}
            >
              Refresh
            </button>
            <button
              disabled={Boolean(busy) || !version}
              onClick={() =>
                run("es-deploy", async () => {
                  await deployElasticsearch(namespace, version);
                })
              }
            >
              Deploy Elasticsearch
            </button>
            <button
              disabled={Boolean(busy) || !es.exists || !version}
              title={!es.exists ? "Despliega Elasticsearch primero" : undefined}
              onClick={() =>
                run("kb-deploy", async () => {
                  await deployKibana(namespace, version);
                })
              }
            >
              Deploy Kibana
            </button>
            <button
              disabled={Boolean(busy) || !es.exists || !version}
              title={!es.exists ? "Despliega Elasticsearch primero" : undefined}
              onClick={openLogstashModal}
            >
              Deploy Logstash
            </button>
            <button
              className="primary"
              type="button"
              disabled={portForwards.kibana.status !== "running"}
              title={
                portForwards.kibana.status !== "running"
                  ? "Activa el port-forward de Kibana primero"
                  : undefined
              }
              onClick={() =>
                window.open("https://localhost:5601", "_blank", "noreferrer")
              }
            >
              Open Kibana
            </button>
          </div>
        </section>

        {error ? <p className="error">{error}</p> : null}

        <section className="panel">
          <h2 className="panel-title">Summary</h2>
          <div className="summary-grid">
            <div className="summary-item">
              <label>Deployment name</label>
              <div className="value">quickstart</div>
            </div>
            <div className="summary-item">
              <label htmlFor="namespace">Namespace</label>
              <select
                id="namespace"
                value={namespace}
                onChange={(e) => {
                  const ns = e.target.value;
                  setNamespace(ns);
                  refreshAll(ns).catch((err) =>
                    setError(err instanceof Error ? err.message : String(err)),
                  );
                }}
              >
                {(cluster?.namespaces || [namespace]).map((ns) => (
                  <option key={ns} value={ns}>
                    {ns}
                  </option>
                ))}
              </select>
            </div>
            <div className="summary-item">
              <label htmlFor="version">Deployment version</label>
              <input
                id="version"
                value={version}
                onChange={(e) => setVersion(e.target.value.trim())}
                placeholder="9.5.0"
                spellCheck={false}
              />
            </div>
            <div className="summary-item">
              <label>Kubernetes context</label>
              <div className="value">{cluster?.context || "—"}</div>
            </div>
            <div className="summary-item">
              <label>Template</label>
              <div className="value">ECK quickstart</div>
            </div>
            <div className="summary-item">
              <label>Components</label>
              <div className="value">
                {[
                  es.exists ? "Elasticsearch" : null,
                  kb.exists ? "Kibana" : null,
                  ls.exists ? "Logstash" : null,
                ]
                  .filter(Boolean)
                  .join(", ") || "none"}
              </div>
            </div>
          </div>
        </section>

        <div className="section-head">
          <h2>Instances</h2>
          <p>Visible solo cuando el recurso existe</p>
        </div>

        {!hasInstances ? (
          <section className="panel">
            <p className="empty-status">
              No hay instancias quickstart en este namespace. Usa Deploy
              Elasticsearch para empezar.
            </p>
          </section>
        ) : (
          <div className="instance-grid">
            {es.exists ? (
              <InstanceCard
                title="Elasticsearch"
                status={es}
                endpoint="https://localhost:9200"
                portForwardRunning={portForwards.es.status === "running"}
                busy={busy}
                onRefresh={() => run("es-refresh", async () => refreshAll())}
                onStop={() =>
                  run("es-delete", async () => {
                    await deleteElasticsearch(namespace);
                  })
                }
              />
            ) : null}
            {kb.exists ? (
              <InstanceCard
                title="Kibana"
                status={kb}
                endpoint="https://localhost:5601"
                portForwardRunning={portForwards.kibana.status === "running"}
                busy={busy}
                onRefresh={() => run("kb-refresh", async () => refreshAll())}
                onStop={() =>
                  run("kb-delete", async () => {
                    await deleteKibana(namespace);
                  })
                }
              />
            ) : null}
            {ls.exists ? (
              <InstanceCard
                title="Logstash"
                status={ls}
                busy={busy}
                onRefresh={() => run("ls-refresh", async () => refreshAll())}
                onStop={() =>
                  run("ls-delete", async () => {
                    await deleteLogstash(namespace);
                  })
                }
                onEditConfig={openLogstashModal}
              />
            ) : null}
          </div>
        )}

        <div className="access-section">
          <button
            type="button"
            className="access-toggle"
            aria-expanded={accessOpen}
            onClick={() => setAccessOpen((open) => !open)}
          >
            <span>Access credentials & port-forward</span>
            <span className="chevron">{accessOpen ? "▾" : "▸"}</span>
          </button>
          {accessOpen ? (
            <div className="access-body">
              <div className="meta">
                <div>
                  <span>user</span>
                  <strong>{creds?.user || "elastic"}</strong>
                </div>
                <div>
                  <span>password</span>
                  <strong>
                    {creds?.password || "(secret aún no disponible)"}
                  </strong>
                </div>
              </div>

              <PortForwardControls
                label="Port-forward Elasticsearch"
                command={creds?.portForwardEs || "—"}
                state={portForwards.es}
                busy={busy}
                onStart={() =>
                  runPortForward("pf-es-start", async () => {
                    await startPortForward("es", namespace);
                  })
                }
                onStop={() =>
                  runPortForward("pf-es-stop", async () => {
                    await stopPortForward("es");
                  })
                }
              />

              <PortForwardControls
                label="Port-forward Kibana"
                command={creds?.portForwardKibana || "—"}
                state={portForwards.kibana}
                busy={busy}
                onStart={() =>
                  runPortForward("pf-kb-start", async () => {
                    await startPortForward("kibana", namespace);
                  })
                }
                onStop={() =>
                  runPortForward("pf-kb-stop", async () => {
                    await stopPortForward("kibana");
                  })
                }
              />
            </div>
          ) : null}
        </div>
      </main>

      {logstashModalOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setLogstashModalOpen(false);
          }}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="logstash-modal-title"
          >
            <h2 id="logstash-modal-title">Deploy Logstash</h2>
            <p className="hint">
              Pipeline <code>config.string</code> del quickstart. Puedes
              editarla antes de aplicar el CR.
            </p>
            <textarea
              value={logstashConfig}
              spellCheck={false}
              onChange={(e) => setLogstashConfig(e.target.value)}
            />
            <div className="modal-actions">
              <button
                type="button"
                className="ghost"
                disabled={Boolean(busy)}
                onClick={() => setLogstashConfig(DEFAULT_LOGSTASH_CONFIG)}
              >
                Reset to example
              </button>
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => setLogstashModalOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={Boolean(busy) || !logstashConfig.trim() || !version}
                onClick={() =>
                  run("ls-deploy", async () => {
                    await deployLogstash(namespace, version, logstashConfig);
                    setLogstashModalOpen(false);
                  })
                }
              >
                Deploy
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PortForwardControls({
  label,
  command,
  state,
  busy,
  onStart,
  onStop,
}: {
  label: string;
  command: string;
  state: PortForwardState;
  busy: string | null;
  onStart: () => void;
  onStop: () => void;
}) {
  const running = state.status === "running";
  return (
    <div className="pf-row">
      <div className="pf-header">
        <label>{label}</label>
        <span className={`pf-status ${state.status}`}>
          {state.status}
          {state.pid ? ` · pid ${state.pid}` : ""}
        </span>
      </div>
      <div className="pf-actions">
        <button
          className="primary"
          disabled={Boolean(busy) || running}
          onClick={onStart}
        >
          Start
        </button>
        <button
          className="danger"
          disabled={Boolean(busy) || state.status === "stopped"}
          onClick={onStop}
        >
          Stop
        </button>
      </div>
      <pre>{command}</pre>
      {state.message ? <p className="hint">{state.message}</p> : null}
    </div>
  );
}

function InstanceCard({
  title,
  status,
  endpoint,
  portForwardRunning,
  busy,
  onRefresh,
  onStop,
  onEditConfig,
}: {
  title: string;
  status: ResourceStatus;
  endpoint?: string;
  portForwardRunning?: boolean;
  busy: string | null;
  onRefresh: () => void;
  onStop: () => void;
  onEditConfig?: () => void;
}) {
  const health = status.health || status.phase || "pending";
  const canOpen = Boolean(endpoint && portForwardRunning);
  return (
    <article className="instance-card">
      <h3>
        {title}
        <span className={`badge ${badgeClassForStatus(status)}`}>{health}</span>
      </h3>
      <div className="instance-meta">
        <span className={`dot ${healthClass(status)}`}>
          {(status.health || status.phase || "pending").toLowerCase()}
        </span>
        <span>v{status.version || "—"}</span>
        <span>{status.name}</span>
        {typeof status.nodes === "number" ? (
          <span>{status.nodes} nodes</span>
        ) : null}
      </div>
      <div className="instance-actions">
        {endpoint ? (
          <button
            className="primary"
            disabled={!canOpen}
            title={
              canOpen
                ? endpoint
                : "Activa el port-forward primero (Access credentials & port-forward)"
            }
            onClick={() => window.open(endpoint, "_blank", "noreferrer")}
          >
            Open
          </button>
        ) : null}
        {onEditConfig ? (
          <button disabled={Boolean(busy)} onClick={onEditConfig}>
            Edit config
          </button>
        ) : null}
        <button disabled={Boolean(busy)} onClick={onRefresh}>
          Refresh
        </button>
        <button className="danger" disabled={Boolean(busy)} onClick={onStop}>
          Stop
        </button>
      </div>
      <ul className="pods">
        {status.pods.length === 0 && <li>No pods</li>}
        {status.pods.map((pod) => (
          <li key={pod.name}>
            <span>{pod.name}</span>
            <span>{pod.phase}</span>
            <span>{pod.ready}</span>
            <span>restarts {pod.restarts}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}
