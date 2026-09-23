# Notice

pi-cliff is a port of [CliffCompaction](https://github.com/nguyenvuthientrang/cliffcompaction).

- Upstream revision ported: `b48d660ae3c1f6037094d6cfc6b5d9f5938a7957` (2026-09-22).
- Upstream author: Trang Nguyen, MIT licensed.
- Paper: *CliffCompaction: Cost-Efficient Compaction for Long-Horizon Coding Agents*, [arXiv:2609.26779](https://arxiv.org/abs/2609.26779).

```bibtex
@article{nguyen2026cliffcompaction,
  title   = {CliffCompaction: Cost-Efficient Compaction for Long-Horizon Coding Agents},
  author  = {Nguyen, Trang and Cho, Eulrang and Chen, Bingqing and Dettmers, Tim},
  journal = {arXiv preprint arXiv:2609.26779},
  year    = {2026}
}
```

The port keeps upstream's mechanical summarisation rules, its drop rules, its treatment of previous summaries, and its fail-open contract. It does not port the HTTP proxy, the daemon and shell-profile installation, the prefix hash store, the provider wire dialects, the terminal watch view, or the image token estimator. `docs/design.md` records each carried and dropped behaviour, and the reasons.

## Upstream license

```
MIT License

Copyright (c) 2026 Trang Nguyen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
