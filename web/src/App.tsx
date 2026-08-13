import { useEffect, useState } from "react";
import {
  DEFAULT_LOGSTASH_CONFIG,
  PROTECTED_NAMESPACES,
  createNamespace,
  deleteElasticAgent,
  deleteElasticsearch,
  deleteFleetServer,
  deleteKibana,
  deleteLogstash,
  deleteNamespace,
  destroyQuickstart,
  deployAllQuickstart,
  deployElasticsearch,
  deployFleetExample,
  deployFleetServer,
  deployKibana,
  deployLogstash,
  findPortForwardState,
  getCluster,
  getCredentials,
  getElasticAgent,
  getElasticsearch,
  getFleetExamples,
  getFleetServer,
  getKibana,
  getLogstash,
  getPodLogs,
  getPortForwards,
  setClusterContext,
  startPortForward,
  stopPortForward,
  type ClusterInfo,
  type Credentials,
  type FleetExampleMeta,
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

function isTerminating(status: ResourceStatus) {
  const health = (status.health || "").toLowerCase();
  const phase = (status.phase || "").toLowerCase();
  return (
    health === "terminating" ||
    phase === "terminating" ||
    status.pods.some((p) => p.phase === "Terminating")
  );
}

function overallBadge(...statuses: ResourceStatus[]) {
  const resources = statuses.filter((r) => r.exists);
  if (resources.length === 0) {
    return { label: "Empty", className: "missing" };
  }
  if (resources.every(isTerminating)) {
    return { label: "Terminating", className: "pending" };
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
  if (isTerminating(status)) return "yellow";
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
  const [fleetServer, setFleetServer] = useState<ResourceStatus>(emptyStatus());
  const [elasticAgent, setElasticAgent] =
    useState<ResourceStatus>(emptyStatus());
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [portForwards, setPortForwards] = useState<PortForwardStatus>({
    es: emptyPortForward("es", 9200, "quickstart-es-http"),
    kibana: emptyPortForward("kibana", 5601, "quickstart-kb-http"),
    extras: [],
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [k8sOpen, setK8sOpen] = useState(false);
  const [stackOpen, setStackOpen] = useState(false);
  const [fleetExamplesOpen, setFleetExamplesOpen] = useState(false);
  const [portForwardOpen, setPortForwardOpen] = useState(false);
  const [logstashModalOpen, setLogstashModalOpen] = useState(false);
  const [logstashConfig, setLogstashConfig] = useState(DEFAULT_LOGSTASH_CONFIG);
  const [destroyModalOpen, setDestroyModalOpen] = useState(false);
  const [deleteNsModalOpen, setDeleteNsModalOpen] = useState(false);
  const [newNamespace, setNewNamespace] = useState("");
  const [includeLogstash, setIncludeLogstash] = useState(true);
  const [heapSize, setHeapSize] = useState("");
  const [nodeCount, setNodeCount] = useState(1);
  const [fleetExamples, setFleetExamples] = useState<FleetExampleMeta[]>([]);
  const [selectedExample, setSelectedExample] = useState("quickstart");
  const [logsModal, setLogsModal] = useState<{
    podName: string;
    tailLines: number;
    logs: string;
    loading: boolean;
    error: string | null;
  } | null>(null);

  async function refreshPortForwards() {
    const status = await getPortForwards();
    setPortForwards(status);
  }

  async function refreshAll(ns = namespace) {
    const [
      esStatus,
      kbStatus,
      lsStatus,
      fsStatus,
      eaStatus,
      credentials,
      pfStatus,
    ] = await Promise.all([
      getElasticsearch(ns),
      getKibana(ns),
      getLogstash(ns),
      getFleetServer(ns),
      getElasticAgent(ns),
      getCredentials(ns),
      getPortForwards(),
    ]);
    setEs(esStatus);
    setKb(kbStatus);
    setLs(lsStatus);
    setFleetServer(fsStatus);
    setElasticAgent(eaStatus);
    setCreds(credentials);
    setPortForwards(pfStatus);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [info, examples] = await Promise.all([
          getCluster(),
          getFleetExamples(),
        ]);
        if (cancelled) return;
        setCluster(info);
        setVersion(info.defaultVersion);
        setFleetExamples(examples.examples);
        if (examples.examples.length > 0) {
          const preferred =
            examples.examples.find((e) => e.id === "quickstart") ||
            examples.examples[0];
          setSelectedExample(preferred.id);
        }
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

  async function run(
    label: string,
    action: () => Promise<string | void>,
  ) {
    setBusy(label);
    setError(null);
    try {
      const refreshNs = await action();
      await refreshAll(typeof refreshNs === "string" ? refreshNs : namespace);
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

  async function loadPodLogs(podName: string, tailLines: number) {
    setLogsModal((prev) =>
      prev
        ? { ...prev, podName, tailLines, loading: true, error: null }
        : {
            podName,
            tailLines,
            logs: "",
            loading: true,
            error: null,
          },
    );
    try {
      const result = await getPodLogs(namespace, podName, tailLines);
      setLogsModal({
        podName: result.name,
        tailLines: result.tailLines,
        logs: result.logs,
        loading: false,
        error: null,
      });
    } catch (err) {
      setLogsModal((prev) => ({
        podName,
        tailLines,
        logs: prev?.logs ?? "",
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  function openPodLogs(podName: string) {
    void loadPodLogs(podName, logsModal?.tailLines || 200);
  }

  const badge = overallBadge(es, kb, ls, fleetServer, elasticAgent);
  const deployedVersion =
    es.version ||
    kb.version ||
    ls.version ||
    fleetServer.version ||
    elasticAgent.version ||
    version;
  const hasInstances =
    es.exists ||
    kb.exists ||
    ls.exists ||
    fleetServer.exists ||
    elasticAgent.exists;
  const canDeleteNamespace = !PROTECTED_NAMESPACES.has(namespace);
  const selectedExampleMeta = fleetExamples.find(
    (e) => e.id === selectedExample,
  );

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
            aria-expanded={k8sOpen}
            onClick={() => setK8sOpen((open) => !open)}
          >
            <h2 className="panel-title">Kubernetes</h2>
            <span className="chevron">{k8sOpen ? "▾" : "▸"}</span>
          </button>
          {k8sOpen ? (
            <div className="panel-body">
              <div className="summary-grid">
                <div className="summary-item summary-item-wide">
                  <label htmlFor="kube-context">Context</label>
                  <select
                    id="kube-context"
                    value={cluster?.context || ""}
                    disabled={Boolean(busy) || !cluster}
                    onChange={(e) => {
                      const next = e.target.value;
                      run("context-switch", async () => {
                        const info = await setClusterContext(next);
                        setCluster(info);
                        const ns = info.namespaces.includes("default")
                          ? "default"
                          : info.namespaces[0] || "default";
                        setNamespace(ns);
                        return ns;
                      });
                    }}
                  >
                    {(cluster?.contexts || [cluster?.context || namespace]).map(
                      (ctx) => (
                        <option key={ctx} value={ctx}>
                          {ctx}
                        </option>
                      ),
                    )}
                  </select>
                </div>
                <div className="summary-item summary-item-wide">
                  <label>API server</label>
                  <div className="value mono-value">{cluster?.server || "—"}</div>
                </div>
                <div className="summary-item summary-item-wide">
                  <label htmlFor="namespace">Namespace</label>
                  <div className="namespace-row">
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
                    <button
                      type="button"
                      className="danger"
                      disabled={Boolean(busy) || !canDeleteNamespace}
                      title={
                        canDeleteNamespace
                          ? `Delete namespace ${namespace} and everything inside it`
                          : `Namespace "${namespace}" is protected`
                      }
                      onClick={() => setDeleteNsModalOpen(true)}
                    >
                      Delete namespace
                    </button>
                  </div>
                </div>
                <div className="summary-item summary-item-wide">
                  <label htmlFor="new-namespace">Create namespace</label>
                  <div className="namespace-row">
                    <input
                      id="new-namespace"
                      value={newNamespace}
                      onChange={(e) => setNewNamespace(e.target.value)}
                      placeholder="my-namespace"
                      spellCheck={false}
                      disabled={Boolean(busy)}
                    />
                    <button
                      type="button"
                      disabled={Boolean(busy) || !newNamespace.trim()}
                      onClick={() =>
                        run("ns-create", async () => {
                          const result = await createNamespace(
                            newNamespace.trim(),
                          );
                          setCluster(result);
                          setNamespace(result.name);
                          setNewNamespace("");
                          return result.name;
                        })
                      }
                    >
                      Create
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </section>

        <section className="panel">
          <button
            type="button"
            className="panel-toggle"
            aria-expanded={stackOpen}
            onClick={() => setStackOpen((open) => !open)}
          >
            <h2 className="panel-title">Stack</h2>
            <span className="chevron">{stackOpen ? "▾" : "▸"}</span>
          </button>
          {stackOpen ? (
            <div className="panel-body">
              <div className="summary-grid">
                <div className="summary-item">
                  <label>Deployment name</label>
                  <div className="value">quickstart</div>
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
                  <label htmlFor="heap-size">ES heap</label>
                  <input
                    id="heap-size"
                    value={heapSize}
                    onChange={(e) => setHeapSize(e.target.value.trim())}
                    placeholder="2g"
                    spellCheck={false}
                    title="Optional JVM heap at deploy time (e.g. 512m, 1g, 2g). Pod memory is set to 2× heap."
                  />
                </div>
                <div className="summary-item">
                  <label htmlFor="node-count">ES nodes</label>
                  <input
                    id="node-count"
                    type="number"
                    min={1}
                    max={9}
                    value={nodeCount}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n)) setNodeCount(n);
                    }}
                    title="nodeSets count (1–9). Needs cluster capacity; odd counts are typical for production quorum."
                  />
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
                      fleetServer.exists ? "Fleet Server" : null,
                      elasticAgent.exists ? "Elastic Agent" : null,
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
                      await deployElasticsearch(namespace, version, {
                        heapSize: heapSize || undefined,
                        nodeCount,
                      });
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
                  disabled={Boolean(busy) || !es.exists || !version}
                  title={
                    !es.exists
                      ? "Deploy Elasticsearch first"
                      : "Deploy Fleet Server only (use Deploy agent configurations for Elastic Agent)"
                  }
                  onClick={() =>
                    run("fleet-deploy", async () => {
                      await deployFleetServer(namespace, version);
                    })
                  }
                >
                  Deploy Fleet
                </button>
                <button
                  className="primary"
                  disabled={Boolean(busy) || !version}
                  title="Deploy Elasticsearch, Kibana (Fleet-ready), optional Logstash, then Fleet Server"
                  onClick={() =>
                    run("deploy-all", async () => {
                      await deployAllQuickstart(namespace, version, {
                        includeLogstash,
                        configString: DEFAULT_LOGSTASH_CONFIG,
                        heapSize: heapSize || undefined,
                        nodeCount,
                      });
                    })
                  }
                >
                  Deploy all
                </button>
                <label className="checkbox-inline">
                  <input
                    type="checkbox"
                    checked={includeLogstash}
                    disabled={Boolean(busy)}
                    onChange={(e) => setIncludeLogstash(e.target.checked)}
                  />
                  Include Logstash in Deploy all
                </label>
                <button
                  className="danger"
                  disabled={Boolean(busy) || !hasInstances}
                  title={
                    hasInstances
                      ? `Delete Agents, Logstash, Kibana, and Elasticsearch in ${namespace}`
                      : "Nothing to destroy in this namespace"
                  }
                  onClick={() => setDestroyModalOpen(true)}
                >
                  Destroy all
                </button>
              </div>
              <div className="fleet-examples">
                <button
                  type="button"
                  className="subsection-toggle"
                  aria-expanded={fleetExamplesOpen}
                  onClick={() => setFleetExamplesOpen((open) => !open)}
                >
                  <h3 className="subsection-title">
                    Deploy agent configurations
                  </h3>
                  <span className="chevron">
                    {fleetExamplesOpen ? "▾" : "▸"}
                  </span>
                </button>
                {fleetExamplesOpen ? (
                  <div className="fleet-examples-body">
                    <p className="hint panel-hint">
                      Deploy an Elastic Agent with a ready-made policy.
                      Requires Elasticsearch and Fleet Server. Applying a
                      configuration overwrites the managed Fleet policies and
                      Agent CR in this namespace.
                    </p>
                    <div className="namespace-row">
                      <select
                        id="fleet-example"
                        value={selectedExample}
                        disabled={Boolean(busy) || fleetExamples.length === 0}
                        onChange={(e) => setSelectedExample(e.target.value)}
                      >
                        {fleetExamples.map((ex) => (
                          <option key={ex.id} value={ex.id}>
                            {ex.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={
                          Boolean(busy) ||
                          !es.exists ||
                          !version ||
                          !selectedExample
                        }
                        title={
                          !es.exists
                            ? "Deploy Elasticsearch first"
                            : selectedExampleMeta?.description
                        }
                        onClick={() =>
                          run("fleet-example", async () => {
                            await deployFleetExample(
                              namespace,
                              version,
                              selectedExample,
                            );
                          })
                        }
                      >
                        Deploy example
                      </button>
                    </div>
                    {selectedExampleMeta ? (
                      <p className="hint example-desc">
                        {selectedExampleMeta.description}
                        {selectedExampleMeta.note
                          ? ` ${selectedExampleMeta.note}`
                          : ""}
                      </p>
                    ) : null}
                  </div>
                ) : null}
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
              No quickstart instances in this namespace. Open Stack and use
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
                onStartPortForward={() =>
                  runPortForward("pf-es-start", async () => {
                    await startPortForward("es", namespace);
                  })
                }
                onViewLogs={openPodLogs}
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
                onStartPortForward={() =>
                  runPortForward("pf-kibana-start", async () => {
                    await startPortForward("kibana", namespace);
                  })
                }
                onViewLogs={openPodLogs}
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
                onViewLogs={openPodLogs}
                onRefresh={() => run("ls-refresh", async () => refreshAll())}
                onStop={() =>
                  run("ls-delete", async () => {
                    await deleteLogstash(namespace);
                  })
                }
                onEditConfig={openLogstashModal}
              />
            ) : null}
            {fleetServer.exists ? (
              <InstanceCard
                title="Fleet Server"
                status={fleetServer}
                busy={busy}
                onViewLogs={openPodLogs}
                onRefresh={() => run("fs-refresh", async () => refreshAll())}
                onStop={() =>
                  run("fs-delete", async () => {
                    await deleteFleetServer(namespace);
                  })
                }
              />
            ) : null}
            {elasticAgent.exists ? (
              <InstanceCard
                title="Elastic Agent"
                status={elasticAgent}
                busy={busy}
                onViewLogs={openPodLogs}
                onRefresh={() => run("ea-refresh", async () => refreshAll())}
                onStop={() =>
                  run("ea-delete", async () => {
                    await deleteElasticAgent(namespace);
                  })
                }
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
              This will permanently delete Fleet Server and Elastic Agent (plus
              related RBAC), then Logstash, Kibana, and Elasticsearch in
              namespace <strong>{namespace}</strong>, remove their PVCs (and
              PVs when the StorageClass reclaim policy is Delete), and stop
              active port-forwards.
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

      {deleteNsModalOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy)
              setDeleteNsModalOpen(false);
          }}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-ns-modal-title"
          >
            <h2 id="delete-ns-modal-title">Delete namespace?</h2>
            <p className="hint">
              This permanently deletes namespace <strong>{namespace}</strong> and
              everything inside it (not only quickstart). Port-forwards will be
              stopped. Deletion may stay in <code>Terminating</code> until
              finalizers (for example PVCs) finish.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => setDeleteNsModalOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                disabled={Boolean(busy)}
                onClick={() =>
                  run("ns-delete", async () => {
                    const result = await deleteNamespace(namespace);
                    setCluster(result);
                    const next = result.namespaces.includes("default")
                      ? "default"
                      : result.namespaces[0] || "default";
                    setNamespace(next);
                    setDeleteNsModalOpen(false);
                    return next;
                  })
                }
              >
                Confirm delete namespace
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {logsModal ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !logsModal.loading) {
              setLogsModal(null);
            }
          }}
        >
          <div
            className="modal logs-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="logs-modal-title"
          >
            <h2 id="logs-modal-title">Pod logs</h2>
            <p className="hint">
              <code>{logsModal.podName}</code> · namespace{" "}
              <strong>{namespace}</strong>
            </p>
            <div className="logs-controls">
              <label htmlFor="log-tail-lines">
                Lines
                <input
                  id="log-tail-lines"
                  type="number"
                  min={1}
                  max={5000}
                  value={logsModal.tailLines}
                  disabled={logsModal.loading}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setLogsModal((prev) =>
                      prev
                        ? {
                            ...prev,
                            tailLines: Number.isFinite(n) ? n : prev.tailLines,
                          }
                        : prev,
                    );
                  }}
                />
              </label>
              <button
                type="button"
                disabled={logsModal.loading}
                onClick={() =>
                  void loadPodLogs(logsModal.podName, logsModal.tailLines)
                }
              >
                Refresh
              </button>
              <button
                type="button"
                disabled={logsModal.loading}
                onClick={() => setLogsModal(null)}
              >
                Close
              </button>
            </div>
            {logsModal.error ? (
              <p className="error">{logsModal.error}</p>
            ) : null}
            <pre className="logs-output">
              {logsModal.loading
                ? "Loading…"
                : logsModal.logs || "(no log output)"}
            </pre>
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
  onStartPortForward,
  onViewLogs,
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
  onStartPortForward?: () => void;
  onViewLogs?: (podName: string) => void;
  onRefresh: () => void;
  onStop: () => void;
  onEditConfig?: () => void;
}) {
  const [credsOpen, setCredsOpen] = useState(false);
  const health = isTerminating(status)
    ? "Terminating"
    : status.health || status.phase || "pending";
  const canOpen = Boolean(endpoint && portForwardRunning);
  return (
    <article className="instance-card">
      <h3>
        {title}
        <span className={`badge ${badgeClassForStatus(status)}`}>{health}</span>
      </h3>
      <div className="instance-meta">
        <span className={`dot ${healthClass(status)}`}>
          {String(health).toLowerCase()}
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
        {canOpen ? (
          <button
            className="primary"
            onClick={() => window.open(endpoint, "_blank", "noreferrer")}
          >
            Open
          </button>
        ) : null}
        {endpoint && !canOpen && onStartPortForward ? (
          <button
            className="primary"
            disabled={Boolean(busy)}
            onClick={onStartPortForward}
          >
            Start port-forward
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
          <li key={pod.name} className="pod-row">
            <span className="pod-name">{pod.name}</span>
            <span>{pod.phase}</span>
            <span>{pod.ready}</span>
            <span>restarts {pod.restarts}</span>
            {onViewLogs ? (
              <button
                type="button"
                className="ghost pod-logs-btn"
                disabled={Boolean(busy)}
                onClick={() => onViewLogs(pod.name)}
              >
                Logs
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </article>
  );
}
