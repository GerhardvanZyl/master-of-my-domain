---
name: nominatim-confidence-gate-verified
description: live-checked - house-level hits carry place_rank 30 + type "house" + addresstype "place" together, not as alternatives
metadata:
  type: project
---

`scripts/geocode-missing.ts` gates Nominatim results to house/building level
before trusting a coordinate — a suburb-centroid match is silently wrong for
every downstream distance/station calc, worse than no coordinate at all.

Ten live requests (curl, 1/request/sec, real User-Agent) against
`https://nominatim.openstreetmap.org/search`, sampled against eight of this
DB's own rows (which already carry Domain-supplied coordinates, so accuracy
was checkable) plus two REA listings:

- All ten house-level hits returned `place_rank: 30`, `type: "house"`,
  `addresstype: "place"`, `class: "place"` — every time, all three together.
  `addresstype: "place"` was never observed without `type: "house"`. Accuracy
  against the Domain-supplied coordinates: within ~6 m at worst, under 1 m for
  several.
- A unit-style address (`2/15 Dunnings Road, Point Cook`) returned the road,
  not the house: `place_rank: 26`, `type: "secondary"`, `addresstype: "road"`,
  `class: "highway"`. Correctly rejected by the rank gate.

The gate (`isHouseLevelMatch` in `scripts/geocode-missing.ts`) was briefly
widened to `place_rank === 30 AND (type === "house" OR addresstype ===
"place")` on the theory that the two fields were alternate observed shapes.
That was wrong — this evidence shows they always co-occur — and the OR branch
was never actually observed independently, only invented. It has been removed:
the gate now requires `place_rank === 30 AND type === "house"` only.

**How to apply:** if extending the geocoder (e.g. adding a Google fallback
provider, or revisiting unit-address handling), re-verify against a couple of
live Nominatim requests before trusting any new literal in the gate — don't
add a second accepted shape without a captured (not inferred) example of it.
