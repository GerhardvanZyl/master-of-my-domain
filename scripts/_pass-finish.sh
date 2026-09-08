#!/bin/sh
# Wait for the listing pass to bridge home, then run the whole downstream with
# no further browser interaction. Exists because the operator gets ONE browser
# confirmation per sync (see the update-properties skill) — so everything after
# that click has to be able to finish on its own.
set -e
cd "E:/Projects 2024/master-of-my-domain"

# Up to 90 min: a backgrounded tab has its timers clamped to ~1/min, which
# stretches the pass's 45s spacing well past its nominal 23 min.
i=0
while [ $i -lt 360 ]; do
  [ -s data/harvest/domain-pass-gz.json ] && break
  i=$((i + 1))
  sleep 15
done
[ -s data/harvest/domain-pass-gz.json ] || { echo "TIMEOUT: pass never bridged"; exit 1; }

echo "=== bridged ==="
node -e '
const fs=require("fs"),zlib=require("zlib");
const raw=fs.readFileSync("data/harvest/domain-pass-gz.json","utf8").trim();
const j=zlib.gunzipSync(Buffer.from(decodeURIComponent(raw),"base64")).toString();
fs.writeFileSync("data/harvest/pass-1.json",j);
const d=JSON.parse(j).d??JSON.parse(j);
const by={};for(const v of Object.values(d))by[v.status??"?"]=(by[v.status??"?"]||0)+1;
console.log(JSON.stringify({listings:Object.keys(d).length,byStatus:by,
  photos:Object.values(d).reduce((n,v)=>n+(v.imgs?.length??0),0)}));
'

echo "=== expand ==="
node scripts/_pass-expand.mjs pass-1

echo "=== apply ==="
node scripts/_pass-apply-live.mjs pass-1

echo "=== push galleries ==="
[ -s data/harvest/_gallery-pass-1.json ] && \
  node scripts/batch-push.mjs --base=http://192.168.68.125:3225 \
    --file=data/harvest/_gallery-pass-1.json --chunk=3

echo "=== push status ==="
[ -s data/harvest/_status-pass-1.json ] && \
  node scripts/batch-push.mjs --base=http://192.168.68.125:3225 \
    --file=data/harvest/_status-pass-1.json

echo "=== verify ==="
node scripts/_verify-live.mjs
