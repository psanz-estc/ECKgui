# ECKgui

UI local mínima para el quickstart de [Elastic Cloud on Kubernetes](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s): desplegar **Elasticsearch** y **Kibana** uno a uno, eligiendo la **versión del Stack**.

## Requisitos

- Node.js 20+
- Operador ECK ya instalado y funcionando
- `kubectl` configurado contra tu cluster Rancher (`~/.kube/config`)

## Arranque

```bash
npm install
npm run dev
```

- UI: http://127.0.0.1:5173
- API: http://127.0.0.1:8787

## Uso

1. Elige **namespace** y **Stack version** (p.ej. `9.5.0` o `8.18.0`).
2. **Deploy Elasticsearch** (`quickstart`).
3. Cuando exista ES, **Deploy Kibana** (misma versión, `elasticsearchRef: quickstart`).
4. Copia la password `elastic`.
5. Usa **Start / Stop** en el panel Acceso para el port-forward (o los comandos `kubectl` como referencia).
6. Abre los enlaces a Kibana (`https://localhost:5601`) y Elasticsearch (`https://localhost:9200`).

Los manifests siguen el quickstart oficial (`node.store.allow_mmap: false`, 1 nodo / 1 instancia).
