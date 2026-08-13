#!/usr/bin/env bash
# Smoke-test the ECKgui quickstart stack on the current kubectl cluster.
#
# Usage:
#   npm run test:cluster
#   NAMESPACE=default KUBE_CONTEXT=my-ctx npm run test:cluster
#   SKIP_HTTP=1 npm run test:cluster
#
set -euo pipefail

NS="${NAMESPACE:-default}"
RESOURCE="${RESOURCE_NAME:-quickstart}"
ES_LOCAL_PORT="${ES_LOCAL_PORT:-19200}"
KB_LOCAL_PORT="${KB_LOCAL_PORT:-15601}"
SKIP_HTTP="${SKIP_HTTP:-0}"

pass=0
fail=0
warn=0

ok()   { pass=$((pass + 1)); printf '  OK   %s\n' "$*"; }
bad()  { fail=$((fail + 1)); printf '  FAIL %s\n' "$*"; }
note() { warn=$((warn + 1)); printf '  WARN %s\n' "$*"; }
section() { printf '\n== %s ==\n' "$*"; }

kc() {
  if [[ -n "${KUBE_CONTEXT:-}" ]]; then
    kubectl --context "$KUBE_CONTEXT" "$@"
  else
    kubectl "$@"
  fi
}

cleanup() {
  if [[ -n "${ES_PF_PID:-}" ]] && kill -0 "$ES_PF_PID" 2>/dev/null; then
    kill "$ES_PF_PID" 2>/dev/null || true
    wait "$ES_PF_PID" 2>/dev/null || true
  fi
  if [[ -n "${KB_PF_PID:-}" ]] && kill -0 "$KB_PF_PID" 2>/dev/null; then
    kill "$KB_PF_PID" 2>/dev/null || true
    wait "$KB_PF_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

wait_tcp() {
  local port="$1" deadline=$((SECONDS + 25))
  while (( SECONDS < deadline )); do
    if (echo >"/dev/tcp/127.0.0.1/${port}") >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.4
  done
  return 1
}

cr_exists() {
  kc -n "$NS" get "$1" "$2" >/dev/null 2>&1
}

section "Cluster"
CTX="${KUBE_CONTEXT:-$(kubectl config current-context 2>/dev/null || echo unknown)}"
ok "context=${CTX} namespace=${NS} resource=${RESOURCE}"

section "Custom resources"
check_cr() {
  local kind="$1" name="$2" label="$3" required="${4:-0}"
  if cr_exists "$kind" "$name"; then
    local health phase
    health="$(kc -n "$NS" get "$kind" "$name" -o jsonpath='{.status.health}' 2>/dev/null || true)"
    phase="$(kc -n "$NS" get "$kind" "$name" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
    ok "${label} exists health=${health:-?} phase=${phase:-?}"
  elif [[ "$required" == "1" ]]; then
    bad "${label} missing"
  else
    note "${label} not deployed"
  fi
}

check_cr "elasticsearch.elasticsearch.k8s.elastic.co" "$RESOURCE" "Elasticsearch" 1
check_cr "kibana.kibana.k8s.elastic.co" "$RESOURCE" "Kibana" 0
check_cr "logstash.logstash.k8s.elastic.co" "$RESOURCE" "Logstash" 0
check_cr "agent.agent.k8s.elastic.co" "fleet-server-quickstart" "Fleet Server" 0
check_cr "agent.agent.k8s.elastic.co" "elastic-agent-quickstart" "Elastic Agent" 0

section "Pods"
pod_out="$(kc -n "$NS" get pods --no-headers 2>/dev/null || true)"
matched="$(printf '%s\n' "$pod_out" | awk -v r="$RESOURCE" '
  $1 ~ r || $1 ~ /fleet-server-quickstart/ || $1 ~ /elastic-agent-quickstart/ { print }
')"

if [[ -z "${matched// }" ]]; then
  bad "no quickstart / fleet pods in namespace ${NS}"
else
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    name="$(awk '{print $1}' <<<"$line")"
    ready="$(awk '{print $2}' <<<"$line")"
    status="$(awk '{print $3}' <<<"$line")"
    case "$status" in
      Running)
        if [[ "$ready" == 0/* ]]; then
          bad "pod ${name} ${ready} ${status}"
        else
          ok "pod ${name} ${ready} ${status}"
        fi
        ;;
      Terminating|Pending|ContainerCreating|PodInitializing)
        note "pod ${name} ${ready} ${status}"
        ;;
      *)
        bad "pod ${name} ${ready} ${status}"
        ;;
    esac
  done <<<"$matched"
fi

if [[ "$SKIP_HTTP" != "1" ]]; then
  section "Elasticsearch HTTP"
  if ! cr_exists "elasticsearch.elasticsearch.k8s.elastic.co" "$RESOURCE"; then
    note "skip ES HTTP — Elasticsearch CR missing"
  else
    PASS="$(kc -n "$NS" get secret "${RESOURCE}-es-elastic-user" \
      -o jsonpath='{.data.elastic}' 2>/dev/null | base64 -d 2>/dev/null || true)"
    if [[ -z "$PASS" ]]; then
      bad "could not read ${RESOURCE}-es-elastic-user secret"
    else
      kc -n "$NS" port-forward "svc/${RESOURCE}-es-http" "${ES_LOCAL_PORT}:9200" \
        >/tmp/eckgui-es-pf.log 2>&1 &
      ES_PF_PID=$!
      if wait_tcp "$ES_LOCAL_PORT"; then
        body="$(curl -sk --max-time 15 -u "elastic:${PASS}" \
          "https://127.0.0.1:${ES_LOCAL_PORT}/_cluster/health" || true)"
        status="$(printf '%s' "$body" | sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
        if [[ "$status" == "green" || "$status" == "yellow" ]]; then
          ok "ES cluster health=${status}"
        else
          bad "ES cluster health unexpected: ${status:-no-status}"
          printf '%s\n' "$body" | head -5
        fi
      else
        bad "ES port-forward not ready (see /tmp/eckgui-es-pf.log)"
      fi
    fi
  fi

  section "Kibana HTTP"
  if ! cr_exists "kibana.kibana.k8s.elastic.co" "$RESOURCE"; then
    note "skip Kibana HTTP — Kibana CR missing"
  else
    PASS="${PASS:-$(kc -n "$NS" get secret "${RESOURCE}-es-elastic-user" \
      -o jsonpath='{.data.elastic}' 2>/dev/null | base64 -d 2>/dev/null || true)}"
    kc -n "$NS" port-forward "svc/${RESOURCE}-kb-http" "${KB_LOCAL_PORT}:5601" \
      >/tmp/eckgui-kb-pf.log 2>&1 &
    KB_PF_PID=$!
    if wait_tcp "$KB_LOCAL_PORT"; then
      code="$(curl -sk --max-time 20 -o /tmp/eckgui-kb-status.json -w '%{http_code}' \
        -u "elastic:${PASS}" \
        "https://127.0.0.1:${KB_LOCAL_PORT}/api/status" || echo 000)"
      if [[ "$code" == "200" ]]; then
        ok "Kibana /api/status HTTP ${code}"
      else
        bad "Kibana /api/status HTTP ${code}"
      fi
    else
      bad "Kibana port-forward not ready (see /tmp/eckgui-kb-pf.log)"
    fi
  fi
else
  section "HTTP checks skipped (SKIP_HTTP=1)"
fi

section "ECKgui API (optional)"
if curl -sf --max-time 2 "http://127.0.0.1:8787/api/cluster" >/tmp/eckgui-api.json 2>/dev/null; then
  ok "ECKgui API reachable on :8787"
else
  note "ECKgui API not running (npm run dev) — skipped"
fi

section "Summary"
printf 'passed=%s warnings=%s failed=%s\n' "$pass" "$warn" "$fail"
[[ "$fail" -eq 0 ]]
