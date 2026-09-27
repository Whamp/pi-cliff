---
id: 01M3J2VKZS77TNS9YRPR94PR16
anchor: function planCliffAutoCompaction
created: 2026-09-27T18:43:22Z
norm: '1'
---

A candidate that keeps the configured assistant/tool steps can fit the model but fail to reduce input because summary framing exceeds the old prefix. Never fall back to one step in that case: only model-unfit protected candidates justify losing additional recent steps.
