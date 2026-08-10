# ECKgui

Minimal local UI for the [Elastic Cloud on Kubernetes](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s) quickstart: deploy **Elasticsearch**, **Kibana**, and **Logstash** one by one, with a selectable **Stack version**.

## Requirements

- Node.js 20+
- ECK operator already installed and running
- `kubectl` configured against your Rancher cluster (`~/.kube/config`)

## Start

```bash
npm install
npm run dev
```

- UI: http://127.0.0.1:5173
- API: http://127.0.0.1:8787

## Usage

1. Choose **namespace** and **Stack version** (e.g. `9.5.0` or `8.18.0`).
2. **Deploy Elasticsearch** (`quickstart`).
3. When ES exists, **Deploy Kibana** (same version, `elasticsearchRef: quickstart`).
4. **Deploy Logstash** opens a modal with an editable `config.string` from the quickstart example.
5. Copy the `elastic` password.
6. Use **Start / Stop** in Access credentials & port-forward (or the `kubectl` commands as reference).
7. Open Kibana (`https://localhost:5601`) and Elasticsearch (`https://localhost:9200`) once port-forward is running.

Manifests follow the official quickstart (`node.store.allow_mmap: false`, 1 node / 1 instance).
