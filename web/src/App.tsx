import { useEffect, useRef, useState } from "react";
import {
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiHeader,
  EuiHeaderLogo,
  EuiHeaderSection,
  EuiHeaderSectionItem,
  EuiHeaderSectionItemButton,
  EuiPageTemplate,
  EuiSpacer,
  EuiText,
  type EuiBadgeProps,
} from "@elastic/eui";
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
  getCluster,
  getCredentials,
  getEckLicense,
  getEckOperator,
  getEckOperatorVersions,
  getElasticAgent,
  getElasticsearch,
  getFleetExamples,
  getFleetServer,
  getKibana,
  getLogstash,
  getPodLogs,
  getPortForwards,
  getStackVersions,
  installEckOperator,
  setClusterContext,
  startEckTrialLicense,
  startPortForward,
  uninstallEckOperator,
  upgradeAllQuickstart,
  updateElasticsearchTopology,
  upgradeElasticsearch,
  upgradeFleetServer,
  upgradeKibana,
  upgradeLogstash,
  // findPortForwardState,
  // stopPortForward,
  type ClusterInfo,
  type ClusterMemory,
  type Credentials,
  type EckLicenseStatus,
  type EckOperatorStatus,
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

function euiBadgeColor(
  className: string,
): EuiBadgeProps["color"] {
  if (className === "healthy") return "success";
  if (className === "unhealthy") return "danger";
  if (className === "pending") return "warning";
  if (className === "missing") return "hollow";
  return "default";
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

function k8sStatusBadge(cluster: ClusterInfo | null): {
  label: string;
  className: string;
} {
  if (!cluster) {
    return { label: "Checking…", className: "pending" };
  }
  if (!cluster.reachable) {
    return { label: "Unreachable", className: "unhealthy" };
  }
  return { label: "Connected", className: "healthy" };
}

function formatGiBytes(bytes: number): string {
  const gi = bytes / 1024 ** 3;
  if (!Number.isFinite(gi) || gi <= 0) return "0 Gi";
  const digits = gi >= 10 ? 1 : 2;
  return `${gi.toFixed(digits)} Gi`;
}

function memoryPressureStatus(
  percent: number,
): "normal" | "high" | "critical" {
  if (percent >= 90) return "critical";
  if (percent >= 75) return "high";
  return "normal";
}

type PendingConfirm = {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  busyKey: string;
  action: () => Promise<string | void>;
};

function ConfirmDialog({
  pending,
  busy,
  onCancel,
  onConfirm,
}: {
  pending: PendingConfirm;
  busy: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
      >
        <h2 id="confirm-modal-title">{pending.title}</h2>
        <p className="hint">{pending.body}</p>
        <div className="modal-actions">
          <button type="button" disabled={Boolean(busy)} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={pending.danger ? "danger" : "primary"}
            disabled={Boolean(busy)}
            onClick={onConfirm}
          >
            {pending.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function RamMeter({ memory }: { memory?: ClusterMemory }) {
  if (!memory || memory.nodeCount === 0) return null;
  const status = memoryPressureStatus(memory.percent);
  const label =
    status === "normal" ? "Normal" : status === "high" ? "High" : "Critical";
  const pct = Math.max(0, Math.min(100, Math.round(memory.percent)));
  const title = `${formatGiBytes(memory.requestBytes)} requested of ${formatGiBytes(memory.allocatableBytes)} allocatable (${formatGiBytes(memory.remainingBytes)} free to schedule)`;
  return (
    <div
      className={`ram-meter ram-meter-${status}`}
      title={title}
      aria-label={`Memory requests ${label} ${pct} percent`}
    >
      <div className="ram-meter-label">Memory requests</div>
      <div className="ram-meter-row">
        <span className="ram-meter-status">{label}</span>
        <div className="ram-meter-track" aria-hidden="true">
          <div className="ram-meter-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="ram-meter-pct">{pct}%</span>
      </div>
    </div>
  );
}

function eckStatusBadge(cluster: ClusterInfo | null): {
  label: string;
  className: string;
} {
  const eck = cluster?.eck;
  if (!cluster) {
    return { label: "Checking…", className: "pending" };
  }
  if (!cluster.reachable) {
    return { label: "Unavailable", className: "unhealthy" };
  }
  if (!eck || eck.phase === "not_installed") {
    return { label: "Not installed", className: "pending" };
  }
  if (eck.phase === "running" && eck.ready) {
    return { label: eck.version ? `Running ${eck.version}` : "Running", className: "healthy" };
  }
  if (eck.phase === "installing") {
    return { label: "Starting", className: "pending" };
  }
  return { label: "Unhealthy", className: "unhealthy" };
}

function compareVersions(a: string, b: string): number {
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

function stackVersionAction(exists: boolean, current: string | undefined, desired: string) {
  if (!exists) return { label: "Deploy", kind: "deploy" as const };
  if (!current || current === desired) {
    return { label: "Deploy", kind: "deploy" as const };
  }
  if (compareVersions(desired, current) > 0) {
    return { label: `Upgrade to ${desired}`, kind: "upgrade" as const };
  }
  return { label: `Change version to ${desired}`, kind: "downgrade" as const };
}

function eckPrimaryAction(eck: EckOperatorStatus | undefined, selected: string) {
  if (!selected) {
    return { label: "Install", kind: "install" as const };
  }
  if (!eck || eck.phase === "not_installed") {
    return { label: `Install ${selected}`, kind: "install" as const };
  }
  const current = eck.version;
  if (!current) {
    return { label: `Install ${selected}`, kind: "install" as const };
  }
  if (current === selected) {
    return {
      label: eck.ready ? `Reapply ${selected}` : `Reinstall ${selected}`,
      kind: "install" as const,
    };
  }
  if (compareVersions(selected, current) > 0) {
    return { label: `Upgrade to ${selected}`, kind: "upgrade" as const };
  }
  return { label: `Switch to ${selected}`, kind: "switch" as const };
}

function VersionPicker({
  id,
  listedLabel,
  customLabel,
  versions,
  value,
  onChange,
  disabled,
}: {
  id: string;
  listedLabel: string;
  customLabel: string;
  versions: string[];
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const inList = versions.includes(value);
  return (
    <>
      <div className="summary-item">
        <label htmlFor={id}>{listedLabel}</label>
        <select
          id={id}
          value={inList ? value : "__custom__"}
          disabled={disabled}
          onChange={(e) => {
            const next = e.target.value;
            if (next !== "__custom__") onChange(next);
          }}
        >
          {versions.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
          {!inList && value ? (
            <option value="__custom__">Custom ({value})</option>
          ) : null}
        </select>
      </div>
      <div className="summary-item">
        <label htmlFor={`${id}-custom`}>{customLabel}</label>
        <input
          id={`${id}-custom`}
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
          placeholder="Not in the list? Type it here"
          spellCheck={false}
          disabled={disabled}
        />
      </div>
    </>
  );
}

type StackTarget = "es" | "kb" | "ls" | "fleet" | "agent" | "all";

/* Kept for Port-forward panel restore:
type ForwardRow = {
  key: string;
  source: string;
  label: string;
  command: string;
  state: PortForwardState;
  detail?: string;
};
*/

export default function App() {
  const [cluster, setCluster] = useState<ClusterInfo | null>(null);
  const [namespace, setNamespace] = useState("default");
  const [version, setVersion] = useState("9.5.0");
  const [stackVersions, setStackVersions] = useState<string[]>(["9.5.0"]);
  const [es, setEs] = useState<ResourceStatus>(emptyStatus());
  const [kb, setKb] = useState<ResourceStatus>(emptyStatus());
  const [ls, setLs] = useState<ResourceStatus>(emptyStatus());
  const [fleetServer, setFleetServer] = useState<ResourceStatus>(emptyStatus());
  const [elasticAgent, setElasticAgent] =
    useState<ResourceStatus>(emptyStatus());
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [eckLicense, setEckLicense] = useState<EckLicenseStatus | null>(null);
  const [trialModalOpen, setTrialModalOpen] = useState(false);
  const [eckOpen, setEckOpen] = useState(false);
  const [eckAutoOpened, setEckAutoOpened] = useState(false);
  const [eckOperatorVersion, setEckOperatorVersion] = useState("3.5.0");
  const [eckVersions, setEckVersions] = useState<string[]>(["3.5.0"]);
  const [eckApplyOpen, setEckApplyOpen] = useState(false);
  const [eckUninstallOpen, setEckUninstallOpen] = useState(false);
  const [eckDeleteCrds, setEckDeleteCrds] = useState(false);
  const [portForwards, setPortForwards] = useState<PortForwardStatus>({
    es: emptyPortForward("es", 9200, "quickstart-es-http"),
    kibana: emptyPortForward("kibana", 5601, "quickstart-kb-http"),
    extras: [],
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [k8sOpen, setK8sOpen] = useState(false);
  const [stackOpen, setStackOpen] = useState(false);
  const [stackTarget, setStackTarget] = useState<StackTarget | null>(null);
  // const [fleetExamplesOpen, setFleetExamplesOpen] = useState(false);
  // const [portForwardOpen, setPortForwardOpen] = useState(false);
  const [logstashModalOpen, setLogstashModalOpen] = useState(false);
  const [logstashConfig, setLogstashConfig] = useState(DEFAULT_LOGSTASH_CONFIG);
  const [destroyModalOpen, setDestroyModalOpen] = useState(false);
  const [deleteNsModalOpen, setDeleteNsModalOpen] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(
    null,
  );
  const [newNamespace, setNewNamespace] = useState("");
  const [includeLogstash, setIncludeLogstash] = useState(true);
  const [heapSize, setHeapSize] = useState("");
  const [lsHeapSize, setLsHeapSize] = useState("");
  const [nodeCount, setNodeCount] = useState(1);
  const esTopologyDirty = useRef(false);
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

  async function refreshCluster() {
    const info = await getCluster();
    setCluster(info);
    return info;
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
      license,
      operator,
      clusterInfo,
    ] = await Promise.all([
      getElasticsearch(ns),
      getKibana(ns),
      getLogstash(ns),
      getFleetServer(ns),
      getElasticAgent(ns),
      getCredentials(ns),
      getPortForwards(),
      getEckLicense().catch(() => null),
      getEckOperator().catch(() => null),
      getCluster().catch(() => null),
    ]);
    setEs(esStatus);
    setKb(kbStatus);
    setLs(lsStatus);
    setFleetServer(fsStatus);
    setElasticAgent(eaStatus);
    setCreds(credentials);
    setPortForwards(pfStatus);
    setEckLicense(license);
    if (!esTopologyDirty.current && esStatus.exists) {
      if (typeof esStatus.count === "number") setNodeCount(esStatus.count);
      setHeapSize(esStatus.heapSize ?? "");
    }
    if (clusterInfo) {
      setCluster(clusterInfo);
    } else if (operator) {
      setCluster((prev) =>
        prev
          ? { ...prev, eck: operator, eckInstalled: operator.installed }
          : prev,
      );
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [info, examples, operatorVersions, stackVersionList] =
          await Promise.all([
            getCluster(),
            getFleetExamples(),
            getEckOperatorVersions().catch(() => null),
            getStackVersions().catch(() => null),
          ]);
        if (cancelled) return;
        setCluster(info);
        if (stackVersionList) {
          setStackVersions(stackVersionList.versions);
          setVersion(stackVersionList.defaultVersion);
        } else {
          setVersion(info.defaultVersion);
        }
        if (operatorVersions) {
          setEckVersions(operatorVersions.versions);
          setEckOperatorVersion(
            info.eck?.version || operatorVersions.defaultVersion,
          );
        } else if (info.eck?.version) {
          setEckOperatorVersion(info.eck.version);
        }
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
  }, [cluster?.reachable, namespace]);

  useEffect(() => {
    if (!cluster?.reachable) return;
    const source = new EventSource("/api/cluster/memory");
    source.onmessage = (event) => {
      try {
        const memory = JSON.parse(event.data) as ClusterMemory;
        setCluster((prev) => (prev ? { ...prev, memory } : prev));
      } catch {
        // Ignore malformed snapshots.
      }
    };
    return () => {
      source.close();
    };
  }, [cluster?.reachable, cluster?.context]);

  useEffect(() => {
    if (eckAutoOpened || !cluster?.reachable) return;
    if (!cluster.eck?.ready) {
      setEckOpen(true);
      setEckAutoOpened(true);
    }
  }, [cluster, eckAutoOpened]);

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

  function confirmRun(spec: PendingConfirm) {
    setPendingConfirm(spec);
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
  const k8sBadge = k8sStatusBadge(cluster);
  const eckBadge = eckStatusBadge(cluster);
  const operatorReady = Boolean(cluster?.reachable && cluster.eck?.ready);
  const operatorNotReadyReason = !cluster?.reachable
    ? "Kubernetes cluster is unreachable"
    : !cluster?.eck?.ready
      ? "Install a healthy ECK operator first"
      : undefined;
  const eckAction = eckPrimaryAction(cluster?.eck, eckOperatorVersion);
  const stackWouldDowngrade = [
    es.version,
    kb.version,
    ls.version,
    fleetServer.version,
    elasticAgent.version,
  ].some((current) => current && compareVersions(version, current) < 0);
  const esAction = stackVersionAction(es.exists, es.version, version);
  const esHeapValid = !heapSize || /^\d+(?:\.\d+)?[mMgG]$/.test(heapSize);
  const esCountValid =
    Number.isInteger(nodeCount) && nodeCount >= 1 && nodeCount <= 9;
  const esTopologyChanged =
    es.exists &&
    (nodeCount !== (es.count ?? es.nodes) ||
      heapSize !== (es.heapSize ?? ""));
  const kbAction = stackVersionAction(kb.exists, kb.version, version);
  const lsAction = stackVersionAction(ls.exists, ls.version, version);
  const fleetAction = stackVersionAction(
    fleetServer.exists,
    fleetServer.version,
    version,
  );
  const stackVersionOptions = [
    ...new Set(
      [
        ...stackVersions,
        version,
        es.version,
        kb.version,
        ls.version,
        fleetServer.version,
        elasticAgent.version,
      ].filter((v): v is string => Boolean(v)),
    ),
  ].sort((a, b) => compareVersions(b, a));
  const allAction = !hasInstances
    ? { label: "Deploy all", kind: "deploy" as const }
    : stackWouldDowngrade
      ? { label: `Change version to ${version}`, kind: "downgrade" as const }
      : { label: `Upgrade all to ${version}`, kind: "upgrade" as const };

  function toggleStackTarget(target: StackTarget) {
    setStackTarget((current) => (current === target ? null : target));
  }

  /* Port-forward panel rows (kept for possible restore):
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
          detail: undefined as string | undefined,
          command: port.command,
          state,
        };
      }),
    ),
  ];
  */

  return (
    <>
      <EuiHeader position="fixed">
        <EuiHeaderSection grow={false}>
          <EuiHeaderSectionItem>
            <EuiHeaderLogo
              iconType="logoElastic"
              href="/"
              onClick={(e) => e.preventDefault()}
              aria-label="ECKgui"
            >
              ECKgui
            </EuiHeaderLogo>
          </EuiHeaderSectionItem>
        </EuiHeaderSection>
        <EuiHeaderSection side="right">
          <EuiHeaderSectionItem>
            <EuiHeaderSectionItemButton
              title={cluster?.server || undefined}
              aria-label="Kubernetes context"
            >
              <EuiText size="xs" color="subdued">
                <span className="eui-textInheritColor mono-value">
                  {cluster?.context || "loading…"}
                </span>
              </EuiText>
            </EuiHeaderSectionItemButton>
          </EuiHeaderSectionItem>
        </EuiHeaderSection>
      </EuiHeader>

      <EuiPageTemplate
        offset={48}
        paddingSize="l"
        restrictWidth={1100}
        grow={false}
        className="eckgui-page"
      >
        <EuiPageTemplate.Header
          pageTitle={
            <>
              ECK quickstart management GUI{" "}
              <EuiBadge color={euiBadgeColor(badge.className)}>
                {badge.label}
              </EuiBadge>
            </>
          }
          description={`Namespace ${namespace} · Stack ${deployedVersion} · ${
            cluster?.context || "—"
          }`}
          rightSideItems={[
            <EuiButtonEmpty
              key="refresh"
              iconType="refresh"
              isDisabled={Boolean(busy)}
              onClick={() =>
                run("refresh", async () => {
                  await refreshCluster();
                })
              }
            >
              Refresh
            </EuiButtonEmpty>,
            <EuiButton
              key="kibana"
              fill
              iconType="popout"
              isDisabled={portForwards.kibana.status !== "running"}
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
            </EuiButton>,
          ]}
        />

        <EuiPageTemplate.Section>
          {error ? (
            <>
              <EuiCallOut title="Error" color="danger" iconType="warning">
                <p>{error}</p>
              </EuiCallOut>
              <EuiSpacer size="m" />
            </>
          ) : null}

        <section className="panel">
          <button
            type="button"
            className="panel-toggle"
            aria-expanded={k8sOpen}
            onClick={() => setK8sOpen((open) => !open)}
          >
            <h2 className="panel-title">
              Kubernetes
              <span
                className={`badge k8s-status-badge ${k8sBadge.className}`}
                title={cluster?.error || cluster?.server || undefined}
              >
                {k8sBadge.label}
              </span>
            </h2>
            <span className="chevron">{k8sOpen ? "▾" : "▸"}</span>
          </button>
          <RamMeter memory={cluster?.memory} />
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
                      if (!next || next === cluster?.context) return;
                      confirmRun({
                        title: `Switch kube context to ${next}?`,
                        body: "This switches the in-app kube context and stops active port-forwards.",
                        confirmLabel: "Switch context",
                        busyKey: "context-switch",
                        action: async () => {
                          const info = await setClusterContext(next);
                          setCluster(info);
                          const ns = info.namespaces.includes("default")
                            ? "default"
                            : info.namespaces[0] || "default";
                          setNamespace(ns);
                          return ns;
                        },
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
                        esTopologyDirty.current = false;
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
                        confirmRun({
                          title: `Create namespace ${newNamespace.trim()}?`,
                          body: "This creates a Kubernetes namespace and switches the UI to it.",
                          confirmLabel: "Create namespace",
                          busyKey: "ns-create",
                          action: async () => {
                            const result = await createNamespace(
                              newNamespace.trim(),
                            );
                            setCluster(result);
                            setNamespace(result.name);
                            setNewNamespace("");
                            return result.name;
                          },
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
            aria-expanded={eckOpen}
            onClick={() => setEckOpen((open) => !open)}
          >
            <h2 className="panel-title">
              ECK
              <span
                className={`badge k8s-status-badge ${eckBadge.className}`}
                title={cluster?.eck?.message || undefined}
              >
                {eckBadge.label}
              </span>
            </h2>
            <span className="chevron">{eckOpen ? "▾" : "▸"}</span>
          </button>
          {eckOpen ? (
            <div className="panel-body">
              <p className="hint panel-hint">
                The operator runs in <code>elastic-system</code>. Stack
                workloads stay in the selected namespace. Installing or
                upgrading the operator can rolling-restart managed pods.
              </p>
              <div className="summary-grid">
                <div className="summary-item">
                  <label>Context</label>
                  <div className="value mono-value">
                    {cluster?.context || "—"}
                  </div>
                </div>
                <div className="summary-item">
                  <label>Namespace</label>
                  <div className="value mono-value">{namespace}</div>
                </div>
                <div className="summary-item">
                  <label>Installed version</label>
                  <div className="value">
                    {cluster?.eck?.version || "—"}
                    {cluster?.eck?.podName ? (
                      <span className="hint"> — {cluster.eck.podName}</span>
                    ) : null}
                  </div>
                </div>
                <VersionPicker
                  id="eck-operator-version"
                  listedLabel="Available versions"
                  customLabel="Custom version"
                  versions={eckVersions}
                  value={eckOperatorVersion}
                  onChange={setEckOperatorVersion}
                  disabled={Boolean(busy) || !cluster?.reachable}
                />
                <div className="summary-item summary-item-wide">
                  <label>ECK license</label>
                  <div className="namespace-row">
                    <div className="value">
                      {eckLicense?.level
                        ? eckLicense.level
                        : cluster?.eck?.installed
                          ? "loading…"
                          : "n/a"}
                      {eckLicense?.message ? (
                        <span className="hint"> — {eckLicense.message}</span>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="primary"
                      disabled={
                        Boolean(busy) ||
                        !cluster?.eck?.ready ||
                        !eckLicense?.canStartTrial
                      }
                      title={
                        !cluster?.eck?.ready
                          ? "ECK operator is not running"
                          : !eckLicense?.canStartTrial
                            ? eckLicense?.message ||
                              "Trial unavailable for this cluster"
                            : "Start a 30-day Enterprise trial (accepts Elastic EULA)"
                      }
                      onClick={() => setTrialModalOpen(true)}
                    >
                      Start Enterprise trial
                    </button>
                  </div>
                </div>
              </div>
              {cluster?.eck?.message ? (
                <p className="hint panel-hint">{cluster.eck.message}</p>
              ) : null}
              <div className="deploy-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={
                    Boolean(busy) ||
                    !cluster?.reachable ||
                    !eckOperatorVersion
                  }
                  onClick={() => setEckApplyOpen(true)}
                >
                  {eckAction.label}
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={
                    Boolean(busy) ||
                    !cluster?.reachable ||
                    !(
                      cluster?.eck?.installed ||
                      cluster?.eck?.version ||
                      cluster?.eck?.podName
                    )
                  }
                  title="Remove the operator. Optionally delete CRDs (destroys all Elastic resources cluster-wide)."
                  onClick={() => {
                    setEckDeleteCrds(false);
                    setEckUninstallOpen(true);
                  }}
                >
                  Uninstall
                </button>
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
                <VersionPicker
                  id="version"
                  listedLabel="Available versions"
                  customLabel="Custom version"
                  versions={stackVersionOptions}
                  value={version}
                  onChange={setVersion}
                  disabled={Boolean(busy)}
                />
              </div>
              {!operatorReady ? (
                <p className="hint panel-hint">
                  {operatorNotReadyReason ||
                    "Install a healthy ECK operator first"}
                  . Open the ECK box to install or repair the operator.
                </p>
              ) : null}
              {operatorReady && stackWouldDowngrade ? (
                <p className="hint panel-hint">
                  The typed stack version is lower than a running component.
                  Elasticsearch data directories generally cannot downgrade.
                </p>
              ) : null}
              {operatorReady && cluster?.eck?.version ? (
                <p className="hint panel-hint">
                  ECK operator {cluster.eck.version} must be compatible with
                  stack {version}. Upgrade the operator in the ECK box first if
                  it is too old.
                </p>
              ) : null}
              {operatorReady ? (
                <p className="hint panel-hint">
                  Upgrade patches only <code>spec.version</code>. Use Apply
                  heap &amp; nodes to change JVM heap or node count without
                  replacing the cluster. ECK rolling-upgrades Elasticsearch one
                  node at a time only with at least 3 master-eligible nodes.
                  With 1 or 2 nodes a version upgrade restarts the whole
                  cluster at once (no quorum). Heap changes still roll one pod
                  at a time. Scaling down deletes removed nodes&apos; data
                  volumes.
                </p>
              ) : null}

              <div className="stack-targets">
                <div className="stack-target">
                  <button
                    type="button"
                    className="subsection-toggle"
                    aria-expanded={stackTarget === "es"}
                    onClick={() => toggleStackTarget("es")}
                  >
                    <h3 className="subsection-title">
                      Elasticsearch
                      {es.exists && es.version ? (
                        <span className="subsection-version">v{es.version}</span>
                      ) : null}
                    </h3>
                    <span className="chevron">
                      {stackTarget === "es" ? "▾" : "▸"}
                    </span>
                  </button>
                  {stackTarget === "es" ? (
                    <div className="stack-target-body">
                      <div className="summary-grid">
                        <div className="summary-item">
                          <label htmlFor="heap-size">ES heap</label>
                          <input
                            id="heap-size"
                            value={heapSize}
                            onChange={(e) => {
                              esTopologyDirty.current = true;
                              setHeapSize(e.target.value.trim());
                            }}
                            placeholder="2g"
                            spellCheck={false}
                            title="Optional JVM heap (e.g. 512m, 1g, 2g). Pod memory is 2× heap. Blank uses the image default."
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
                              if (Number.isFinite(n)) {
                                esTopologyDirty.current = true;
                                setNodeCount(n);
                              }
                            }}
                            title="nodeSets count (1–9). Use 3+ for rolling version upgrades."
                          />
                        </div>
                      </div>
                      <div className="deploy-actions">
                        <button
                          className="primary"
                          disabled={
                            Boolean(busy) ||
                            !version ||
                            !operatorReady ||
                            esAction.kind === "downgrade"
                          }
                          title={
                            !operatorReady
                              ? operatorNotReadyReason
                              : esAction.kind === "downgrade"
                                ? "Elasticsearch generally cannot downgrade an existing data directory"
                                : undefined
                          }
                          onClick={() =>
                            confirmRun({
                              title: es.exists
                                ? `Upgrade Elasticsearch to ${version}?`
                                : `Deploy Elasticsearch ${version}?`,
                              body: es.exists
                                ? `This patches spec.version on quickstart in ${namespace} from ${es.version || "unknown"} to ${version}. Heap and node count stay as they are.`
                                : `This creates Elasticsearch quickstart in ${namespace} with ${nodeCount} node${nodeCount === 1 ? "" : "s"}${heapSize ? ` and heap ${heapSize}` : ""}.`,
                              confirmLabel: esAction.label,
                              busyKey: "es-deploy",
                              action: async () => {
                                if (es.exists) {
                                  await upgradeElasticsearch(
                                    namespace,
                                    version,
                                  );
                                  return;
                                }
                                await deployElasticsearch(namespace, version, {
                                  heapSize: heapSize || undefined,
                                  nodeCount,
                                });
                              },
                            })
                          }
                        >
                          {esAction.label}
                        </button>
                        {es.exists ? (
                          <button
                            type="button"
                            className="ghost"
                            disabled={
                              Boolean(busy) ||
                              !operatorReady ||
                              !esTopologyChanged ||
                              !esHeapValid ||
                              !esCountValid
                            }
                            title={
                              !operatorReady
                                ? operatorNotReadyReason
                                : !esCountValid
                                  ? "Node count must be between 1 and 9"
                                  : !esHeapValid
                                    ? 'Heap must look like "512m", "1g", or "2g"'
                                    : !esTopologyChanged
                                      ? "Heap and node count already match the cluster"
                                      : es.count != null &&
                                          nodeCount < es.count
                                        ? "Scaling down deletes removed nodes' data volumes"
                                        : "Patch node count and heap without changing version"
                            }
                            onClick={() =>
                              confirmRun({
                                title: "Apply Elasticsearch heap and nodes?",
                                body:
                                  es.count != null && nodeCount < es.count
                                    ? `This sets ${nodeCount} node${nodeCount === 1 ? "" : "s"} and heap ${heapSize || "(image default)"} on quickstart in ${namespace}. Scaling down deletes removed nodes' data volumes.`
                                    : `This sets ${nodeCount} node${nodeCount === 1 ? "" : "s"} and heap ${heapSize || "(image default)"} on quickstart in ${namespace}. Version is not changed.`,
                                confirmLabel: "Apply heap & nodes",
                                busyKey: "es-topology",
                                action: async () => {
                                  await updateElasticsearchTopology(
                                    namespace,
                                    {
                                      heapSize,
                                      nodeCount,
                                    },
                                  );
                                  esTopologyDirty.current = false;
                                },
                              })
                            }
                          >
                            Apply heap & nodes
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="stack-target">
                  <button
                    type="button"
                    className="subsection-toggle"
                    aria-expanded={stackTarget === "kb"}
                    onClick={() => toggleStackTarget("kb")}
                  >
                    <h3 className="subsection-title">
                      Kibana
                      {kb.exists && kb.version ? (
                        <span className="subsection-version">v{kb.version}</span>
                      ) : null}
                    </h3>
                    <span className="chevron">
                      {stackTarget === "kb" ? "▾" : "▸"}
                    </span>
                  </button>
                  {stackTarget === "kb" ? (
                    <div className="stack-target-body">
                      <p className="hint panel-hint">
                        Deploys Kibana named quickstart against Elasticsearch.
                      </p>
                      <div className="deploy-actions">
                        <button
                          className="primary"
                          disabled={
                            Boolean(busy) ||
                            !es.exists ||
                            !version ||
                            !operatorReady
                          }
                          title={
                            !operatorReady
                              ? operatorNotReadyReason
                              : !es.exists
                                ? "Deploy Elasticsearch first"
                                : undefined
                          }
                          onClick={() =>
                            confirmRun({
                              title: kb.exists
                                ? `Upgrade Kibana to ${version}?`
                                : `Deploy Kibana ${version}?`,
                              body: kb.exists
                                ? `This patches spec.version on Kibana quickstart in ${namespace} from ${kb.version || "unknown"} to ${version}.`
                                : `This creates Kibana quickstart in ${namespace} against Elasticsearch.`,
                              confirmLabel: kbAction.label,
                              busyKey: "kb-deploy",
                              action: async () => {
                                if (kb.exists) {
                                  await upgradeKibana(namespace, version);
                                  return;
                                }
                                await deployKibana(namespace, version);
                              },
                            })
                          }
                        >
                          {kbAction.label}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="stack-target">
                  <button
                    type="button"
                    className="subsection-toggle"
                    aria-expanded={stackTarget === "ls"}
                    onClick={() => {
                      if (stackTarget !== "ls") {
                        setLogstashConfig(
                          ls.configString?.trim() || DEFAULT_LOGSTASH_CONFIG,
                        );
                      }
                      toggleStackTarget("ls");
                    }}
                  >
                    <h3 className="subsection-title">
                      Logstash
                      {ls.exists && ls.version ? (
                        <span className="subsection-version">v{ls.version}</span>
                      ) : null}
                    </h3>
                    <span className="chevron">
                      {stackTarget === "ls" ? "▾" : "▸"}
                    </span>
                  </button>
                  {stackTarget === "ls" ? (
                    <div className="stack-target-body">
                      <p className="hint panel-hint">
                        Uses the version selected at the top of Stack. Upgrade
                        patches only <code>spec.version</code> and keeps the
                        current pipeline. Deploy (first time) applies the
                        pipeline and heap from this form.
                      </p>
                      <div className="summary-grid">
                        <div className="summary-item">
                          <label htmlFor="ls-heap-size">LS heap</label>
                          <input
                            id="ls-heap-size"
                            value={lsHeapSize}
                            onChange={(e) =>
                              setLsHeapSize(e.target.value.trim())
                            }
                            placeholder="1g"
                            spellCheck={false}
                            title="Optional JVM heap (e.g. 512m, 1g). Pod memory is 2× heap."
                          />
                        </div>
                      </div>
                      <label htmlFor="ls-config">Pipeline config.string</label>
                      <textarea
                        id="ls-config"
                        value={logstashConfig}
                        spellCheck={false}
                        onChange={(e) => setLogstashConfig(e.target.value)}
                      />
                      <div className="deploy-actions">
                        <button
                          className="primary"
                          disabled={
                            Boolean(busy) ||
                            !es.exists ||
                            !version ||
                            !operatorReady ||
                            (!ls.exists && !logstashConfig.trim())
                          }
                          title={
                            !operatorReady
                              ? operatorNotReadyReason
                              : !es.exists
                                ? "Deploy Elasticsearch first"
                                : undefined
                          }
                          onClick={() =>
                            confirmRun({
                              title: ls.exists
                                ? `Upgrade Logstash to ${version}?`
                                : `Deploy Logstash ${version}?`,
                              body: ls.exists
                                ? `This patches spec.version on Logstash quickstart in ${namespace} from ${ls.version || "unknown"} to ${version}. The current pipeline is kept.`
                                : `This creates Logstash quickstart in ${namespace}${lsHeapSize ? ` with heap ${lsHeapSize}` : ""}.`,
                              confirmLabel: lsAction.label,
                              busyKey: "ls-deploy",
                              action: async () => {
                                if (ls.exists) {
                                  await upgradeLogstash(namespace, version);
                                  return;
                                }
                                await deployLogstash(
                                  namespace,
                                  version,
                                  logstashConfig.trim() ||
                                    DEFAULT_LOGSTASH_CONFIG,
                                  { heapSize: lsHeapSize || undefined },
                                );
                              },
                            })
                          }
                        >
                          {lsAction.label}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="stack-target">
                  <button
                    type="button"
                    className="subsection-toggle"
                    aria-expanded={stackTarget === "fleet"}
                    onClick={() => toggleStackTarget("fleet")}
                  >
                    <h3 className="subsection-title">
                      Fleet
                      {fleetServer.exists && fleetServer.version ? (
                        <span className="subsection-version">
                          v{fleetServer.version}
                        </span>
                      ) : null}
                    </h3>
                    <span className="chevron">
                      {stackTarget === "fleet" ? "▾" : "▸"}
                    </span>
                  </button>
                  {stackTarget === "fleet" ? (
                    <div className="stack-target-body">
                      <p className="hint panel-hint">
                        Deploys Fleet Server only (Kibana Fleet config + Agent
                        CR). Use Agent below for a data-plane Elastic Agent.
                      </p>
                      <div className="deploy-actions">
                        <button
                          className="primary"
                          disabled={
                            Boolean(busy) ||
                            !es.exists ||
                            !version ||
                            !operatorReady
                          }
                          title={
                            !operatorReady
                              ? operatorNotReadyReason
                              : !es.exists
                                ? "Deploy Elasticsearch first"
                                : undefined
                          }
                          onClick={() =>
                            confirmRun({
                              title: fleetServer.exists
                                ? `Upgrade Fleet Server to ${version}?`
                                : `Deploy Fleet Server ${version}?`,
                              body: fleetServer.exists
                                ? `This patches spec.version on Fleet Server in ${namespace} from ${fleetServer.version || "unknown"} to ${version}.`
                                : `This deploys Fleet Server in ${namespace} (Kibana Fleet config + Agent CR).`,
                              confirmLabel:
                                fleetAction.kind === "deploy"
                                  ? "Deploy Fleet"
                                  : fleetAction.label,
                              busyKey: "fleet-deploy",
                              action: async () => {
                                if (fleetServer.exists) {
                                  await upgradeFleetServer(
                                    namespace,
                                    version,
                                  );
                                  return;
                                }
                                await deployFleetServer(namespace, version);
                              },
                            })
                          }
                        >
                          {fleetAction.kind === "deploy"
                            ? "Deploy Fleet"
                            : fleetAction.label}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="stack-target">
                  <button
                    type="button"
                    className="subsection-toggle"
                    aria-expanded={stackTarget === "agent"}
                    onClick={() => toggleStackTarget("agent")}
                  >
                    <h3 className="subsection-title">
                      Agent
                      {elasticAgent.exists && elasticAgent.version ? (
                        <span className="subsection-version">
                          v{elasticAgent.version}
                        </span>
                      ) : null}
                    </h3>
                    <span className="chevron">
                      {stackTarget === "agent" ? "▾" : "▸"}
                    </span>
                  </button>
                  {stackTarget === "agent" ? (
                    <div className="stack-target-body">
                      <p className="hint panel-hint">
                        Deploy an Elastic Agent with a ready-made policy.
                        Requires Elasticsearch. Applying a configuration
                        overwrites managed Fleet policies and the Agent CR.
                      </p>
                      <div className="namespace-row">
                        <select
                          id="fleet-example"
                          value={selectedExample}
                          disabled={
                            Boolean(busy) || fleetExamples.length === 0
                          }
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
                          className="primary"
                          disabled={
                            Boolean(busy) ||
                            !es.exists ||
                            !version ||
                            !selectedExample ||
                            !operatorReady
                          }
                          title={
                            !operatorReady
                              ? operatorNotReadyReason
                              : !es.exists
                              ? "Deploy Elasticsearch first"
                              : selectedExampleMeta?.description
                          }
                          onClick={() =>
                            confirmRun({
                              title: `Deploy Agent example ${selectedExampleMeta?.name || selectedExample}?`,
                              body: `This applies the ${selectedExample} configuration in ${namespace} at stack ${version}. It overwrites managed Fleet policies and the Agent CR.`,
                              confirmLabel: "Deploy example",
                              busyKey: "fleet-example",
                              action: async () => {
                                await deployFleetExample(
                                  namespace,
                                  version,
                                  selectedExample,
                                );
                              },
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

                <div className="stack-target">
                  <button
                    type="button"
                    className="subsection-toggle"
                    aria-expanded={stackTarget === "all"}
                    onClick={() => toggleStackTarget("all")}
                  >
                    <h3 className="subsection-title">Deploy full stack</h3>
                    <span className="chevron">
                      {stackTarget === "all" ? "▾" : "▸"}
                    </span>
                  </button>
                  {stackTarget === "all" ? (
                    <div className="stack-target-body">
                      <p className="hint panel-hint">
                        Deploy creates Elasticsearch, Kibana (Fleet-ready),
                        optional Logstash, then Fleet Server. Upgrade all
                        patches <code>spec.version</code> on existing CRs only.
                        Elasticsearch rolling-upgrades only with 3+ master
                        nodes; smaller clusters restart all ES pods together.
                      </p>
                      <label className="checkbox-inline">
                        <input
                          type="checkbox"
                          checked={includeLogstash}
                          disabled={Boolean(busy)}
                          onChange={(e) =>
                            setIncludeLogstash(e.target.checked)
                          }
                        />
                        Include Logstash
                      </label>
                      <div className="deploy-actions">
                        <button
                          className="primary"
                          disabled={
                            Boolean(busy) ||
                            !version ||
                            !operatorReady ||
                            (allAction.kind !== "deploy" &&
                              es.exists &&
                              esAction.kind === "downgrade")
                          }
                          title={
                            !operatorReady
                              ? operatorNotReadyReason
                              : allAction.kind !== "deploy" &&
                                  es.exists &&
                                  esAction.kind === "downgrade"
                                ? "Elasticsearch generally cannot downgrade an existing data directory"
                                : undefined
                          }
                          onClick={() =>
                            confirmRun({
                              title:
                                allAction.kind !== "deploy"
                                  ? `Upgrade all to ${version}?`
                                  : `Deploy full stack ${version}?`,
                              body:
                                allAction.kind !== "deploy"
                                  ? `This patches spec.version on existing quickstart resources in ${namespace}. Elasticsearch rolling-upgrades only with 3+ master nodes.`
                                  : `This creates Elasticsearch, Kibana${includeLogstash ? ", Logstash" : ""}, and Fleet Server in ${namespace}.`,
                              confirmLabel: allAction.label,
                              busyKey: "deploy-all",
                              action: async () => {
                                if (allAction.kind !== "deploy") {
                                  await upgradeAllQuickstart(
                                    namespace,
                                    version,
                                  );
                                  return;
                                }
                                await deployAllQuickstart(namespace, version, {
                                  includeLogstash,
                                  configString:
                                    logstashConfig.trim() ||
                                    DEFAULT_LOGSTASH_CONFIG,
                                  heapSize: heapSize || undefined,
                                  lsHeapSize: lsHeapSize || undefined,
                                  nodeCount,
                                });
                              },
                            })
                          }
                        >
                          {allAction.label}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="deploy-actions stack-destroy">
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
              Deploy Elasticsearch to get started. The ECK operator must be
              running first.
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
                  confirmRun({
                    title: "Stop Elasticsearch?",
                    body: `This deletes Elasticsearch quickstart in ${namespace}. Data volumes may be removed depending on volumeClaimDeletePolicy.`,
                    confirmLabel: "Stop Elasticsearch",
                    danger: true,
                    busyKey: "es-delete",
                    action: async () => {
                      await deleteElasticsearch(namespace);
                    },
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
                  confirmRun({
                    title: "Stop Kibana?",
                    body: `This deletes Kibana quickstart in ${namespace}.`,
                    confirmLabel: "Stop Kibana",
                    danger: true,
                    busyKey: "kb-delete",
                    action: async () => {
                      await deleteKibana(namespace);
                    },
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
                onUpgrade={
                  version && ls.version !== version
                    ? {
                        label: lsAction.label,
                        disabled: Boolean(busy) || !operatorReady || !es.exists,
                        title: !operatorReady
                          ? operatorNotReadyReason
                          : !es.exists
                            ? "Elasticsearch must still exist to upgrade Logstash"
                            : undefined,
                        onClick: () =>
                          confirmRun({
                            title: `Upgrade Logstash to ${version}?`,
                            body: `This patches spec.version on Logstash quickstart in ${namespace} from ${ls.version || "unknown"} to ${version}.`,
                            confirmLabel: lsAction.label,
                            busyKey: "ls-deploy",
                            action: async () => {
                              await upgradeLogstash(namespace, version);
                            },
                          }),
                      }
                    : undefined
                }
                onStop={() =>
                  confirmRun({
                    title: "Stop Logstash?",
                    body: `This deletes Logstash quickstart in ${namespace}.`,
                    confirmLabel: "Stop Logstash",
                    danger: true,
                    busyKey: "ls-delete",
                    action: async () => {
                      await deleteLogstash(namespace);
                    },
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
                  confirmRun({
                    title: "Stop Fleet Server?",
                    body: `This deletes Fleet Server in ${namespace}.`,
                    confirmLabel: "Stop Fleet Server",
                    danger: true,
                    busyKey: "fs-delete",
                    action: async () => {
                      await deleteFleetServer(namespace);
                    },
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
                  confirmRun({
                    title: "Stop Elastic Agent?",
                    body: `This deletes Elastic Agent in ${namespace}.`,
                    confirmLabel: "Stop Elastic Agent",
                    danger: true,
                    busyKey: "ea-delete",
                    action: async () => {
                      await deleteElasticAgent(namespace);
                    },
                  })
                }
              />
            ) : null}
          </div>
        )}

        {/* Port-forward panel hidden — use Start port-forward on instance cards.
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
        */}
        </EuiPageTemplate.Section>
      </EuiPageTemplate>

      {pendingConfirm ? (
        <ConfirmDialog
          pending={pendingConfirm}
          busy={busy}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() =>
            run(pendingConfirm.busyKey, async () => {
              const result = await pendingConfirm.action();
              setPendingConfirm(null);
              return result;
            })
          }
        />
      ) : null}

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
                disabled={
                  Boolean(busy) ||
                  !logstashConfig.trim() ||
                  !version ||
                  !operatorReady
                }
                title={!operatorReady ? operatorNotReadyReason : undefined}
                onClick={() =>
                  run("ls-deploy", async () => {
                    await deployLogstash(namespace, version, logstashConfig, {
                      heapSize: lsHeapSize || undefined,
                    });
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

      {trialModalOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) setTrialModalOpen(false);
          }}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="trial-modal-title"
          >
            <h2 id="trial-modal-title">Start Enterprise trial?</h2>
            <p className="hint">
              This creates the{" "}
              <code>eck-trial-license</code> secret in{" "}
              <code>{eckLicense?.operatorNamespace || "elastic-system"}</code>{" "}
              and starts a 30-day ECK Enterprise trial. A trial can only be
              activated once. By continuing you accept the{" "}
              <a
                href="https://www.elastic.co/eula"
                target="_blank"
                rel="noreferrer"
              >
                Elastic EULA
              </a>
              .
            </p>
            <div className="modal-actions">
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => setTrialModalOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={Boolean(busy)}
                onClick={() =>
                  run("eck-trial", async () => {
                    const next = await startEckTrialLicense();
                    setEckLicense(next);
                    setTrialModalOpen(false);
                  })
                }
              >
                Accept EULA &amp; start trial
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {eckApplyOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) setEckApplyOpen(false);
          }}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="eck-apply-modal-title"
          >
            <h2 id="eck-apply-modal-title">
              {eckAction.kind === "switch"
                ? `Switch operator to ${eckOperatorVersion}?`
                : eckAction.kind === "upgrade"
                  ? `Upgrade operator to ${eckOperatorVersion}?`
                  : `${eckAction.label}?`}
            </h2>
            <p className="hint">
              This applies official YAML manifests from download.elastic.co
              (CRDs, then operator). The operator lives in{" "}
              <code>elastic-system</code>. Upgrading can rolling-restart
              managed Elasticsearch and Kibana pods.
              {eckAction.kind === "switch"
                ? " Downgrading removes the current operator first. Deleting CRDs is not part of this action."
                : ""}
            </p>
            <div className="modal-actions">
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => setEckApplyOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={Boolean(busy)}
                onClick={() =>
                  run("eck-install", async () => {
                    await installEckOperator(eckOperatorVersion);
                    setEckApplyOpen(false);
                    await refreshCluster();
                  })
                }
              >
                {eckAction.label}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {eckUninstallOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy)
              setEckUninstallOpen(false);
          }}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="eck-uninstall-modal-title"
          >
            <h2 id="eck-uninstall-modal-title">Uninstall ECK operator?</h2>
            <p className="hint">
              This deletes the operator resources from{" "}
              <code>elastic-system</code> using the official operator.yaml for{" "}
              {cluster?.eck?.version || eckOperatorVersion}. Stack CRs stay
              unless you also delete CRDs.
            </p>
            <label className="checkbox-inline">
              <input
                type="checkbox"
                checked={eckDeleteCrds}
                disabled={Boolean(busy)}
                onChange={(e) => setEckDeleteCrds(e.target.checked)}
              />
              Also delete CRDs (removes all Elastic resources in all namespaces)
            </label>
            {eckDeleteCrds ? (
              <p className="hint">
                Deleting CRDs triggers deletion of Elasticsearch, Kibana,
                Logstash, Agent, and related custom resources cluster-wide.
              </p>
            ) : null}
            <div className="modal-actions">
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => setEckUninstallOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                disabled={Boolean(busy)}
                onClick={() =>
                  run("eck-uninstall", async () => {
                    await uninstallEckOperator({
                      deleteCrds: eckDeleteCrds,
                      version: cluster?.eck?.version || eckOperatorVersion,
                    });
                    setEckUninstallOpen(false);
                    setEckDeleteCrds(false);
                    await refreshCluster();
                  })
                }
              >
                Confirm uninstall
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
    </>
  );
}

/* Kept for Port-forward panel restore:
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
*/

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
  onUpgrade,
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
  onUpgrade?: {
    label: string;
    disabled?: boolean;
    title?: string;
    onClick: () => void;
  };
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
        {onUpgrade ? (
          <button
            className="primary"
            disabled={onUpgrade.disabled}
            title={onUpgrade.title}
            onClick={onUpgrade.onClick}
          >
            {onUpgrade.label}
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
