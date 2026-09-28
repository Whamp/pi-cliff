---
id: 01M3MV4X3NRF25QWABFN8KB7A6
anchor: function planCliffAutoCompaction
created: 2026-09-28T20:26:21Z
norm: '1'
sig: c733d0a26d42c6f7
body_hash: 0c5a866d371fc44f
raw_hash: c103594cd9d23111
lines: 85-163
---

A candidate that keeps the configured assistant/tool steps can fit the model but fail to reduce input because summary framing exceeds the old prefix. Never fall back to one step in that case: only model-unfit protected candidates justify losing additional recent steps.
