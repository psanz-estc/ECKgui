import { useEffect, useState } from "react";
import {
  DEFAULT_LOGSTASH_CONFIG,
  deleteElasticsearch,
  deleteKibana,
  deleteLogstash,
  destroyQuickstart,
  deployElasticsearch,
  deployKibana,
  deployLogstash,
  findPortForwardState,
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
  type ResourceStatus,
} from "./api";

const emptyStatus = (): ResourceStatus => ({
  name: "quickstart",
  exists: false,
  pods: [],
  services: [],
});

const emptyPortForward = (
  target: string,
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

type ForwardRow = {
  key: string;
  source: string;
  label: string;
  command: string;
  state: PortForwardState;
  detail?: string;
};

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
    extras: [],
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [managementOpen, setManagementOpen] = useState(false);
  const [portForwardOpen, setPortForwardOpen] = useState(false);
  const [logstashModalOpen, setLogstashModalOpen] = useState(false);
  const [logstashConfig, setLogstashConfig] = useState(DEFAULT_LOGSTASH_CONFIG);
  const [destroyModalOpen, setDestroyModalOpen] = useState(false);

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

  const forwardRows: ForwardRow[] = [
    {
      key: "es",
      source: "Elasticsearch",
      label: "quickstart-es-http · 9200/TCP",
      command:
        creds?.portForwardEs ||
        `kubectl -n ${namespace} port-forward service/quickstart-es-http 9200:9200`,
      state: portForwards.es,
    },
    {
      key: "kibana",
      source: "Kibana",
      label: "quickstart-kb-http · 5601/TCP",
      command:
        creds?.portForwardKibana ||
        `kubectl -n ${namespace} port-forward service/quickstart-kb-http 5601:5601`,
      state: portForwards.kibana,
    },
    ...(ls.services || []).flatMap((svc) =>
      svc.ports.map((port) => {
        const state =
          findPortForwardState(portForwards, port.forwardTarget) ||
          emptyPortForward(port.forwardTarget, port.port, svc.name);
        return {
          key: port.forwardTarget,
          source: "Logstash",
          label: `${svc.name} · ${port.name} · ${port.port}/${port.protocol}`,
          detail:
            `${svc.type}` +
            (typeof port.nodePort === "number"
              ? ` · NodePort ${port.nodePort}`
              : ""),
          command: port.command,
          state,
        };
      }),
    ),
  ];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-brand">
          <img src="/eck-logo.png" alt="ECK" className="topbar-logo" />
          <span>ECKgui</span>
        </div>
        <div className="topbar-meta" title={cluster?.server}>
          {cluster?.context || "loading…"}
        </div>
      </header>

      <main className="page">
        <section className="deploy-header">
          <div className="deploy-title">
            <h1>
              ECK quickstart management GUI
              <span className={`badge ${badge.className}`}>{badge.label}</span>
            </h1>
            <p className="subtitle">
              Namespace {namespace} · Stack {deployedVersion} ·{" "}
              {cluster?.context || "—"}
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
              className="primary"
              type="button"
              disabled={portForwards.kibana.status !== "running"}
              title={
                portForwards.kibana.status !== "running"
                  ? "Start the Kibana port-forward first"
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
          <button
            type="button"
            className="panel-toggle"
            aria-expanded={managementOpen}
            onClick={() => setManagementOpen((open) => !open)}
          >
            <h2 className="panel-title">Management</h2>
            <span className="chevron">{managementOpen ? "▾" : "▸"}</span>
          </button>
          {managementOpen ? (
            <div className="panel-body">
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
                        setError(
                          err instanceof Error ? err.message : String(err),
                        ),
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
              <div className="deploy-actions">
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
                  title={
                    !es.exists ? "Deploy Elasticsearch first" : undefined
                  }
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
                  title={
                    !es.exists ? "Deploy Elasticsearch first" : undefined
                  }
                  onClick={openLogstashModal}
                >
                  Deploy Logstash
                </button>
                <button
                  className="danger"
                  disabled={Boolean(busy) || !hasInstances}
                  title={
                    hasInstances
                      ? `Delete Logstash, Kibana, and Elasticsearch in ${namespace}`
                      : "Nothing to destroy in this namespace"
                  }
                  onClick={() => setDestroyModalOpen(true)}
                >
                  Destroy all
                </button>
              </div>
            </div>
          ) : null}
        </section>

        <div className="section-head">
          <h2>Instances</h2>
          <p>Shown only when the resource exists</p>
        </div>

        {!hasInstances ? (
          <section className="panel">
            <p className="empty-status">
              No quickstart instances in this namespace. Open Management and use
              Deploy Elasticsearch to get started.
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
                credentials={creds}
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

        <section className="panel port-forward-panel">
          <button
            type="button"
            className="panel-toggle"
            aria-expanded={portForwardOpen}
            onClick={() => setPortForwardOpen((open) => !open)}
          >
            <h2 className="panel-title">Port-forward</h2>
            <span className="chevron">{portForwardOpen ? "▾" : "▸"}</span>
          </button>
          {portForwardOpen ? (
            <div className="panel-body">
              <p className="hint panel-hint">
                Elasticsearch, Kibana, and discovered Logstash services.
              </p>
              {forwardRows.map((row) => (
                <PortForwardControls
                  key={row.key}
                  source={row.source}
                  label={row.label}
                  detail={row.detail}
                  command={row.command}
                  state={row.state}
                  busy={busy}
                  onStart={() =>
                    runPortForward(`pf-${row.key}-start`, async () => {
                      await startPortForward(row.key, namespace);
                    })
                  }
                  onStop={() =>
                    runPortForward(`pf-${row.key}-stop`, async () => {
                      await stopPortForward(row.key);
                    })
                  }
                />
              ))}
            </div>
          ) : null}
        </section>
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
              Quickstart pipeline <code>config.string</code>. You can edit it
              before applying the CR.
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

      {destroyModalOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) setDestroyModalOpen(false);
          }}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="destroy-modal-title"
          >
            <h2 id="destroy-modal-title">Destroy all resources?</h2>
            <p className="hint">
              This will permanently delete the <code>quickstart</code> Logstash,
              Kibana, and Elasticsearch resources in namespace{" "}
              <strong>{namespace}</strong>, and stop active port-forwards.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => setDestroyModalOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                disabled={Boolean(busy)}
                onClick={() =>
                  run("destroy-all", async () => {
                    await destroyQuickstart(namespace);
                    setDestroyModalOpen(false);
                  })
                }
              >
                Confirm destroy
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PortForwardControls({
  source,
  label,
  detail,
  command,
  state,
  busy,
  onStart,
  onStop,
}: {
  source: string;
  label: string;
  detail?: string;
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
        <div>
          <div className="pf-source">{source}</div>
          <label>{label}</label>
          {detail ? <div className="pf-detail">{detail}</div> : null}
        </div>
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
  credentials,
  busy,
  onRefresh,
  onStop,
  onEditConfig,
}: {
  title: string;
  status: ResourceStatus;
  endpoint?: string;
  portForwardRunning?: boolean;
  credentials?: Credentials | null;
  busy: string | null;
  onRefresh: () => void;
  onStop: () => void;
  onEditConfig?: () => void;
}) {
  const [credsOpen, setCredsOpen] = useState(false);
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
      {credentials ? (
        <div className="credentials-block">
          <button
            type="button"
            className="credentials-toggle"
            aria-expanded={credsOpen}
            onClick={() => setCredsOpen((open) => !open)}
          >
            <span className="credentials-title">Access credentials</span>
            <span className="chevron">{credsOpen ? "▾" : "▸"}</span>
          </button>
          {credsOpen ? (
            <div className="meta">
              <div>
                <span>user</span>
                <strong>{credentials.user || "elastic"}</strong>
              </div>
              <div>
                <span>password</span>
                <strong>
                  {credentials.password || "(secret not available yet)"}
                </strong>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="instance-actions">
        {endpoint ? (
          <button
            className="primary"
            disabled={!canOpen}
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
      {endpoint && !canOpen ? (
        <p className="open-hint">
          Open needs an active port-forward. Start it in the Port-forward panel
          below.
        </p>
      ) : null}
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
