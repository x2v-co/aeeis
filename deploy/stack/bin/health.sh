#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# Readiness probe for systemd / fleet-health (via ssh). Exit 0 only when the
# API /readyz is ready, the Worker is RUNNING, and the API answers on the
# tailnet bind address. Probes run inside the stack's network namespace via
# the api container (loopback). Prints one JSON line.
set -euo pipefail
# shellcheck source=_lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"
probe='
const auth={authorization:"Bearer "+(process.env.AEEIS_ACCESS_TOKEN||"")};
const get=(u,h)=>fetch(u,{headers:h,signal:AbortSignal.timeout(8000)}).then(r=>r.json()).catch(e=>({error:String(e.message||e)}));
Promise.all([get("http://127.0.0.1:4323/readyz",auth),get("http://127.0.0.1:4324/readyz",{})]).then(([api,w])=>{
  const failing=(api.checks||[]).filter(c=>c.required&&!c.ready).map(c=>c.name);
  const ok=api.status==="ready"&&w.status==="ready"&&w.workerState==="RUNNING";
  console.log(JSON.stringify({ok,api:api.status??api.error,worker:w.workerState??w.error,buildId:w.buildId,taskQueue:w.taskQueue,failingRequired:failing}));
  process.exit(ok?0:1);
});'
inner="$(dc exec -T -e AEEIS_ACCESS_TOKEN api node -e "$probe" 2>/dev/null)" && rc=0 || rc=$?
code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://${AEEIS_BIND_IP}:${AEEIS_API_PORT:-4323}/health" || true)"
printf '{"stack":"%s","bindHealthHttp":"%s","probe":%s}\n' "$AEEIS_STACK" "$code" "${inner:-null}"
[[ $rc -eq 0 && "$code" == 200 ]]
