# YAEU

**Yet Another ECK UI.** Local web UI for running an [Elastic Cloud on Kubernetes (ECK)](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s) **quickstart** stack against the cluster in your kubeconfig.

It talks to Kubernetes through `kubectl`’s config (`~/.kube/config`). You can install the ECK operator, deploy Elasticsearch / Kibana / Logstash / Fleet Server / Elastic Agent as `quickstart` resources, change stack version, scale Elasticsearch, port-forward to ES and Kibana, and tear the stack down again.

This is a laptop/lab tool, not a production control plane.

## What it does

- **Kubernetes** — pick kube context and namespace, create/delete namespaces, see how much RAM is already **requested** on the node (what the scheduler will allow, not live RSS).
- **ECK** — install, upgrade, switch, or uninstall the operator from official YAML on `download.elastic.co`. Optional Enterprise trial.
- **Stack** — pick a stack version (from Elastic’s artifacts API, or type a custom one). Deploy or upgrade Elasticsearch, Kibana, Logstash, Fleet Server, and Elastic Agent, or the full quickstart. Elasticsearch heap and node count can be applied without replacing the cluster.
- **Instances** — health, pods, logs, `elastic` password, and start/stop port-forward to `https://localhost:9200` and `https://localhost:5601`.
- **Destroy all** — delete the quickstart resources and their PVCs in the selected namespace.

Mutating actions (deploy, upgrade, stop, apply heap/nodes, operator install, and similar) ask for confirmation first.

Resource name is always `quickstart`. Elasticsearch uses `node.store.allow_mmap: false` so it can run on typical local Kubernetes (Rancher Desktop, kind, Colima, and so on).

## Requirements

- **Node.js 20+** and npm
- **`kubectl`** on your `PATH`, with a working kubeconfig (`kubectl get nodes` succeeds)
- A **Kubernetes cluster** you are allowed to use (local single-node is fine)
- Ability to **pull Elastic images** (`docker.elastic.co/...`) from the cluster
- Enough **node RAM** for the topology you pick (a 2–3 node Elasticsearch cluster plus Kibana is several GiB of *requests*; raise the VM memory in Rancher Desktop if pods stay `Pending`)

You do **not** need the ECK operator installed beforehand **if** your user can create cluster-scoped RBAC (see [Installing the operator](#installing-the-operator)).

The API binds to `127.0.0.1` only.

## Install and run

From the repo root:

```bash
npm install
npm run dev
```

| | URL |
| --- | --- |
| UI | http://127.0.0.1:5173 |
| API | http://127.0.0.1:8787 |

Leave that process running. Vite proxies `/api` to the server.

Optional: `PORT=8787` changes the API port (the Vite proxy still expects `8787` unless you change `web/vite.config.ts`).

### Production-style build

```bash
npm run build
npm start
```

`npm start` serves **only the API** on port 8787. For day-to-day use, prefer `npm run dev`.

## First-time walkthrough

1. Open http://127.0.0.1:5173.
2. **Kubernetes** — confirm the context is the cluster you want and pick a namespace (default `default`). Protected namespaces (`default`, `kube-system`, `kube-public`, `kube-node-lease`, `elastic-system`) cannot be deleted from the UI.
3. **ECK** — if the operator is not running, choose a version (default is a recent 3.x) and install it. Wait until the badge shows it is running.
4. **Stack** — choose a stack version (for example `9.5.2`). Deploy Elasticsearch first (or **Deploy full stack**). For a **rolling** Elasticsearch version upgrade, use **3 or more** master-eligible nodes; 1–2 nodes restart together (no quorum).
5. When Elasticsearch is green, deploy Kibana (and optionally Logstash / Fleet).
6. On the **Elasticsearch** instance card, start the port-forward, then **Open Kibana** (or open `https://localhost:5601`). Accept the self-signed cert. Password is under **Access credentials** (from secret `quickstart-es-elastic-user`).

Browsers keep Kibana Dev Tools history in **localStorage** for `https://localhost:5601`. Destroying the cluster does not clear that; use Console → History, or clear site data for that origin.

## Installing the operator

The official operator manifest creates ClusterRole `elastic-operator` with cluster-wide permissions. Kubernetes **will not** let you create that role unless you already have those permissions (privilege escalation prevention).

On **GKE**, a Google account that can only work in a namespace typically gets `403 Forbidden` on install. You need `roles/container.admin` (or a `cluster-admin` ClusterRoleBinding), or ask someone who has that to apply the manifests:

```bash
kubectl apply -f https://download.elastic.co/downloads/eck/3.5.0/crds.yaml
kubectl apply -f https://download.elastic.co/downloads/eck/3.5.0/operator.yaml
```

Use the same operator version you selected in the UI. After the operator is running in `elastic-system`, YAEU can deploy stack resources with ordinary namespace permissions.

## Upgrades and Elasticsearch topology

- **Upgrade** patches only `spec.version`. Heap, node count, and Logstash pipelines stay as they are.
- **Apply heap & nodes** changes JVM heap (`ES_JAVA_OPTS`, pod memory ≈ 2× heap) and `nodeSets` count. Scaling **down** deletes the extra nodes’ data volumes (`DeleteOnScaledownAndClusterDeletion`).
- Elasticsearch **cannot be downgraded** onto existing data directories; the UI blocks that.

## Smoke-test the cluster

With `kubectl` pointing at the same cluster:

```bash
npm run test:cluster
```

| Env | Meaning |
| --- | --- |
| `NAMESPACE` | Namespace to check (default `default`) |
| `KUBE_CONTEXT` | Override kube context |
| `SKIP_HTTP=1` | CR/pod checks only; no port-forward |

Pass means the Elasticsearch CR exists, ES health is green or yellow over HTTPS, relevant pods are Running, and Kibana `/api/status` is 200 when Kibana is deployed.

## Layout

```
yaeu/
  server/   Fastify API + Kubernetes client
  web/      Vite + React UI
  scripts/  cluster smoke test
```
