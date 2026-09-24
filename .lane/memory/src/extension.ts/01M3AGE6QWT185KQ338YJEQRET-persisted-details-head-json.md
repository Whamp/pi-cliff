---
id: 01M3AGE6QWT185KQ338YJEQRET
anchor: function readCliffHeadRecord
created: 2026-09-24T20:06:47Z
norm: '1'
sig: 818b74e989d62464
body_hash: 061f1baa2ce51c80
raw_hash: 82ae48003630e1ee
lines: 305-323
---

Persisted details/head JSON must be decoded through own fields: copying an own JSON __proto__ key into {} changes that copy's prototype and lets inherited version/head/kind/text pass. This bypass is local to malformed records; it is not global prototype pollution.
