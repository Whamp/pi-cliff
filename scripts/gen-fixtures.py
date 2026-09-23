#!/usr/bin/env python3
"""Regenerate test/fixtures/expected.json from test/fixtures/inputs.json.

This is the port's fidelity lever. Every expected string in the repository is written by upstream's
own `compact()`, never by a re-implementation, so `test/cliff.test.ts` compares this TypeScript port
against upstream's real output rather than against someone's reading of it.

Each case in inputs.json is turned into Anthropic-dialect message dicts, compacted with
`keep_recent=0` so that every turn lands in the summarised region (pi owns the cut, so the harness
must not test upstream's), and the resulting summary text is written out verbatim.

Upstream needs only the standard library. Verified against CPython 3.14 with `sys.path` pointed at
the clone's `src/`.

Run it with:

    python3 scripts/gen-fixtures.py
    python3 scripts/gen-fixtures.py --upstream-src /path/to/cliffcompaction/src
    CLIFF_UPSTREAM_SRC=/path/to/cliffcompaction/src python3 scripts/gen-fixtures.py
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_UPSTREAM_SRC = "/tmp/pi-github-repos/nguyenvuthientrang/cliffcompaction/src"
UPSTREAM_REVISION = "b48d660ae3c1f6037094d6cfc6b5d9f5938a7957"

# Config fields the port carries, in the camelCase spelling config.json and TypeScript use.
CONFIG_FIELDS = {
    "thoughtMaxChars": "thought_max_chars",
    "thinkingMaxChars": "thinking_max_chars",
    "cmdMaxChars": "cmd_max_chars",
    "resultMaxChars": "result_max_chars",
    "humanMaxChars": "human_max_chars",
    "keepThinking": "keep_thinking",
}


class FixtureError(Exception):
    """A fixture case that cannot be turned into an upstream run."""


@dataclass(frozen=True)
class Upstream:
    """The pieces of upstream the generator drives, loaded from one clone path."""

    compact: Callable
    config: Callable
    dialect: Any
    summary_header: str


def import_upstream(upstream_src: Path) -> Upstream:
    """Load upstream's `compact`, its Anthropic dialect, and `Config` from a clone path."""
    if not (upstream_src / "cliffcompaction").is_dir():
        raise FixtureError(
            f"no cliffcompaction package under {upstream_src}. Clone upstream at revision "
            f"{UPSTREAM_REVISION} and pass --upstream-src or CLIFF_UPSTREAM_SRC."
        )
    sys.path.insert(0, str(upstream_src))
    try:
        from cliffcompaction.cliff import compact
        from cliffcompaction.config import Config
        from cliffcompaction.dialects.anthropic import DIALECT
        from cliffcompaction.dialects.base import SUMMARY_HEADER
    except ImportError as exc:  # upstream claims stdlib only; a failure here is a bad path
        raise FixtureError(f"could not import cliffcompaction from {upstream_src}: {exc}") from exc
    return Upstream(compact, Config, DIALECT, SUMMARY_HEADER)


def expand_text(value: Any) -> str:
    """Resolve a text node: a string, or {"$repeat": ["X", 3000]} for a long run of one string."""
    if isinstance(value, str):
        return value
    if isinstance(value, dict) and "$repeat" in value:
        unit, count = value["$repeat"]
        if not isinstance(unit, str) or not isinstance(count, int) or count < 0:
            raise FixtureError(f"bad $repeat node: {value!r}")
        return unit * count
    raise FixtureError(f"expected a text node, got {value!r}")


def expand_blocks(blocks: list[dict], *, role: str) -> list[dict]:
    """Turn neutral content blocks into Anthropic content blocks."""
    out: list[dict] = []
    for block in blocks:
        kind = block.get("type")
        if kind == "text":
            out.append({"type": "text", "text": expand_text(block["text"])})
        elif kind == "thinking":
            # A real signed block: the signature is provider metadata that must never leak.
            out.append(
                {
                    "type": "thinking",
                    "thinking": expand_text(block["text"]),
                    "signature": "EqQBCgIYAsignedblob",
                }
            )
        elif kind == "redactedThinking":
            out.append({"type": "redacted_thinking", "data": block["data"]})
        elif kind == "image":
            out.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": block["mimeType"],
                        "data": block["data"],
                    },
                }
            )
        elif kind == "toolCall":
            if role != "assistant":
                raise FixtureError(f"toolCall blocks belong to assistant messages, not {role}")
            out.append(
                {
                    "type": "tool_use",
                    "id": block["id"],
                    "name": tool_name(block),
                    "input": block["args"],
                }
            )
        else:
            raise FixtureError(f"unknown block type {kind!r}")
    return out


def tool_name(block: dict) -> str:
    """Flatten pi's separate namespace field into the one name upstream's wire carries."""
    name = block["name"]
    namespace = block.get("namespace")
    return f"{namespace}.{name}" if namespace else name


def to_anthropic_message(message: dict, summary_header: str) -> dict:
    """Build the message dict upstream would have received for one neutral message."""
    role = message["role"]
    if role == "human":
        return {"role": "user", "content": expand_blocks(message["blocks"], role=role)}
    if role == "assistant":
        return {"role": "assistant", "content": expand_blocks(message["blocks"], role=role)}
    if role == "system":
        return {"role": "system", "content": expand_blocks(message["blocks"], role=role)}
    if role == "toolResult":
        return {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": message["toolUseId"],
                    "content": expand_blocks(message.get("content", []), role="toolResult"),
                }
            ],
        }
    if role == "previousSummary":
        # Upstream recognises its own summaries by this marker alone.
        return {"role": "user", "content": f"{summary_header}\n\n{expand_text(message['text'])}"}
    raise FixtureError(f"unknown message role {role!r}")


def upstream_revision(upstream_src: Path) -> str:
    """Record which clone produced the fixtures, or "unknown" when git cannot say."""
    try:
        found = subprocess.run(
            ["git", "-C", str(upstream_src), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except Exception:  # noqa: BLE001 - provenance is informative, never load-bearing
        return "unknown"
    return found


def expected_head_len(messages: list[dict]) -> int:
    """How many leading messages the port treats as the carried head.

    Upstream keeps everything before the first assistant message verbatim and outside the summary, so
    the fixture comparison excludes exactly that region. If upstream's own head disagrees with the
    port's reading of the same messages, the case is not comparable and generation stops.
    """
    head = 0
    for message in messages:
        if message["role"] in ("human", "system"):
            head += 1
            continue
        break
    return head


def summarise(case: dict, upstream: Upstream, config: Any) -> str:
    """Compact one case and return the summary text upstream wrote for it."""
    messages = [to_anthropic_message(m, upstream.summary_header) for m in case["messages"]]
    result = upstream.compact(messages, upstream.dialect, config)
    name = case["name"]
    if result is None:
        raise FixtureError(
            f"{name}: upstream found nothing to compact. keep_recent=0 compacts every turn, so a "
            "case needs at least two messages after its leading human and system messages."
        )
    head = expected_head_len(case["messages"])
    if result.head_len != head:
        raise FixtureError(
            f"{name}: upstream kept {result.head_len} verbatim head message(s) but the port treats "
            f"{head} as the carried head, so this case cannot be compared part for part."
        )
    summary_content = result.summary["content"]
    if not isinstance(summary_content, str):
        raise FixtureError(f"{name}: expected a string summary, got {type(summary_content)}")
    return summary_content


def build_expected(cases: list[dict], upstream: Upstream) -> dict:
    """Render every case, rejecting duplicate names on the way."""
    expected: dict[str, str] = {}
    for case in cases:
        for key in ("name", "mirrors", "messages"):
            if key not in case:
                raise FixtureError(f"case without a {key!r} field: {case}")
        name = case["name"]
        if name in expected:
            raise FixtureError(f"duplicate case name {name!r}")
        unknown = set(case.get("config", {})) - set(CONFIG_FIELDS)
        if unknown:
            raise FixtureError(f"{name}: unknown config keys {sorted(unknown)}")
        fields = {
            CONFIG_FIELDS[key]: value for key, value in case.get("config", {}).items()
        }
        # pi owns the cut, so the harness summarises every turn instead of keeping three.
        config = upstream.config(keep_recent=0, **fields)
        expected[name] = summarise(case, upstream, config)
        print(f"  {name}")
    return expected


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--upstream-src",
        default=os.environ.get("CLIFF_UPSTREAM_SRC", DEFAULT_UPSTREAM_SRC),
        help="path to the cliffcompaction clone's src directory",
    )
    parser.add_argument(
        "--inputs", default=str(REPO_ROOT / "test/fixtures/inputs.json"), help="fixture input set"
    )
    parser.add_argument(
        "--expected",
        default=str(REPO_ROOT / "test/fixtures/expected.json"),
        help="where to write the generated expectations",
    )
    args = parser.parse_args()

    try:
        upstream = import_upstream(Path(args.upstream_src).resolve())
        document = json.loads(Path(args.inputs).read_text(encoding="utf-8"))
        cases = document["cases"]
        print(f"generating {len(cases)} cases from upstream at {args.upstream_src}")
        expected = build_expected(cases, upstream)
    except FixtureError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    defaults = upstream.config()
    output = {
        "generatedBy": "scripts/gen-fixtures.py",
        "warning": "Generated by running upstream's compact(). Do not edit by hand.",
        "upstream": {
            "src": str(Path(args.upstream_src).resolve()),
            "portRev": UPSTREAM_REVISION,
            "cloneRev": upstream_revision(Path(args.upstream_src).resolve()),
        },
        "defaults": {
            camel: getattr(defaults, snake) for camel, snake in CONFIG_FIELDS.items()
        },
        "cases": expected,
    }
    Path(args.expected).write_text(
        json.dumps(output, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"wrote {args.expected}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
