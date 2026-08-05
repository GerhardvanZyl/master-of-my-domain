---
name: node-fetch-overpass-blocked
description: Node's native fetch (undici) cannot reliably reach overpass-api.de from this dev machine; curl works. Shell out to curl for Overpass calls.
metadata:
  type: project
---

On this machine, Node 23's built-in `fetch` (undici) fails against
`https://overpass-api.de/api/interpreter` — first with HTTP 406 Not
Acceptable, then with `UND_ERR_CONNECT_TIMEOUT` on repeat attempts — while
`curl` to the exact same URL from the exact same shell succeeds every time
(200 OK). Tried: custom User-Agent headers (curl-style strings sometimes got
through once, then still timed out), `dns.setDefaultResultOrder('ipv4first')`
— none reliably fixed it. Root cause not fully diagnosed (looks like local
firewall/AV or TLS-fingerprint-based blocking specific to the node.exe
process, since curl on the same host/network is unaffected).

**Why:** any script that needs to hit `overpass-api.de` (or possibly other
endpoints with similar bot-detection) from this repo should shell out to
`curl` via `node:child_process` (`execFile`) rather than using `fetch`
directly. Confirmed working pattern in
`scripts/lib/overpass-poi.ts` (`fetchOverpass`): `curl -sS -f --max-time 90
-X POST <url> --data-urlencode data=<query>`, with retry/backoff since the
public Overpass instance also returns transient 502/503/504 under load.

**How to apply:** if a future script (this repo or elsewhere on this same
machine) adds a new external HTTP call and gets inexplicable 406/connect-
timeout errors from Node's fetch while curl works fine in the same shell,
try shelling out to curl before spending time debugging TLS/DNS. Check
whether the target is a public/rate-limited API (Overpass, similar
OSM-adjacent services) — those are the ones observed doing this.
