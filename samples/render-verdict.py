#!/usr/bin/env python3
"""
render-verdict.py: turn a Provenex verdict JSON into a single-file HTML report.

The verdict JSON is what /v1/receipts returns to the client. Everything
needed to render is already in that JSON; this script just formats it.
No network calls, no installs beyond Python 3 (stdlib only).

Usage:
  python3 render-verdict.py verdict.json verdict.html
  curl ... | python3 render-verdict.py - verdict.html
  python3 render-verdict.py verdict.json -        # write HTML to stdout

The same HTML the Rust provenex-ingest binary produces with --report html.
"""
from __future__ import annotations

import datetime as _dt
import html as _html
import json
import sys


def _esc(s: object) -> str:
    return _html.escape(str(s) if s is not None else "", quote=True)


def render(source_label: str, verdict: dict, version: str = "py-render-2026-06") -> str:
    now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    red = verdict.get("red_verdicts") or 0
    receipts_ingested = verdict.get("receipts_ingested") or 0
    tenant = verdict.get("tenant_id") or "(unknown)"
    verdicts = verdict.get("verdicts") or []

    badge = "RED" if red > 0 else "OK"
    badge_class = "badge-red" if red > 0 else "badge-ok"
    headline = (
        (verdicts[0].get("binding_reason") if verdicts else None)
        or ("No red verdicts; closure walked clean." if red == 0 else "Cross-zone composition detected.")
    )

    cards = []
    for i, vd in enumerate(verdicts):
        binding = vd.get("binding_reason") or "(unclassified)"
        risk = vd.get("risk") or "?"
        key = vd.get("correlation_key") or "?"
        explanation = vd.get("explanation") or ""
        cards.append(
            f'<div class="card">'
            f'<div class="card-header">'
            f'<span class="binding">{_esc(binding)}</span>'
            f'<span class="risk risk-{_esc(risk.lower())}">{_esc(risk)}</span>'
            f'<span class="idx">#{i + 1}</span></div>'
            f'<p class="explanation">{_esc(explanation)}</p>'
            f'<p class="key">correlation: <code>{_esc(key)}</code></p>'
            f"</div>"
        )

    raw_pretty = json.dumps(verdict, indent=2, ensure_ascii=False)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Provenex verdict, {_esc(headline)}</title>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 920px; margin: 2rem auto; padding: 0 1rem; color: #1f1f1f; line-height: 1.55; background: #fafafa; }}
  h1 {{ font-size: 1.7rem; margin: 0 0 .3rem; }}
  h2 {{ font-size: 1.1rem; margin: 2rem 0 .8rem; padding-bottom: .25rem; border-bottom: 1px solid #ddd; color: #444; }}
  .badge {{ display: inline-block; padding: 2px 10px; border-radius: 4px; font-weight: 700; font-size: 0.85rem; letter-spacing: .04em; margin-right: .5rem; }}
  .badge-red {{ background: #d83b3b; color: #fff; }}
  .badge-ok {{ background: #2c9c5e; color: #fff; }}
  .meta {{ color: #666; margin: .25rem 0 1.5rem; font-size: 0.9rem; }}
  .stats {{ display: flex; gap: 1.5rem; padding: 1rem 1.25rem; background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; margin: 1.5rem 0; }}
  .stat {{ flex: 1; }}
  .stat-label {{ font-size: 0.85rem; color: #666; text-transform: uppercase; letter-spacing: .04em; }}
  .stat-value {{ font-size: 1.4rem; font-weight: 700; margin-top: 4px; }}
  .card {{ background: #fff; border: 1px solid #e5e5e5; border-left: 4px solid #d83b3b; border-radius: 6px; padding: 1rem 1.25rem; margin: .75rem 0; }}
  .card-header {{ display: flex; align-items: center; gap: .75rem; margin-bottom: .4rem; }}
  .binding {{ font-weight: 700; font-family: ui-monospace, Menlo, monospace; font-size: 0.95rem; color: #d83b3b; }}
  .risk {{ font-size: 0.75rem; padding: 2px 8px; border-radius: 999px; font-weight: 700; text-transform: uppercase; }}
  .risk-high {{ background: #fee; color: #a00; }}
  .risk-medium {{ background: #fff5d6; color: #9a6800; }}
  .risk-low {{ background: #e6f4ea; color: #2c7a3f; }}
  .risk-unknown {{ background: #eee; color: #555; }}
  .idx {{ margin-left: auto; color: #888; font-family: ui-monospace, Menlo, monospace; font-size: 0.85rem; }}
  .explanation {{ margin: .35rem 0; }}
  .key {{ font-size: 0.85rem; color: #666; margin: .2rem 0 0; }}
  code {{ background: #f0f0f0; padding: 1px 5px; border-radius: 3px; font-size: 0.88em; }}
  pre {{ background: #1f1f1f; color: #e6e6e6; padding: 1rem 1.25rem; border-radius: 6px; overflow-x: auto; font-size: 0.85rem; line-height: 1.45; }}
  details {{ margin: 1rem 0; }}
  details summary {{ cursor: pointer; color: #5560b4; font-weight: 500; padding: .5rem 0; }}
  footer {{ margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #ddd; color: #777; font-size: 0.9rem; }}
  footer a {{ color: #5560b4; }}
  .source-label {{ font-family: ui-monospace, Menlo, monospace; color: #444; font-size: 0.9rem; }}
</style>
</head>
<body>
<header>
  <span class="badge {badge_class}">{badge}</span>
  <h1>{_esc(headline)}</h1>
  <p class="meta">Source: <span class="source-label">{_esc(source_label)}</span></p>
</header>

<div class="stats">
  <div class="stat"><div class="stat-label">Egress points evaluated</div><div class="stat-value">{receipts_ingested}</div></div>
  <div class="stat"><div class="stat-label">Red verdicts</div><div class="stat-value">{red}</div></div>
  <div class="stat"><div class="stat-label">Tenant</div><div class="stat-value" style="font-family: ui-monospace, Menlo, monospace; font-size: 0.95rem; word-break: break-all;">{_esc(tenant)}</div></div>
</div>

<h2>Verdicts ({len(verdicts)})</h2>
{"".join(cards) if cards else '<p style="color: #555; font-style: italic;">Closure walked clean; no red verdicts on this trace.</p>'}

<h2>Raw response</h2>
<details>
  <summary>Show raw verdict JSON</summary>
  <pre>{_esc(raw_pretty)}</pre>
</details>

<footer>
  <p>Generated by <code>render-verdict.py</code> ({version}) on {now}.</p>
  <p>Questions / feedback: <a href="mailto:skulk@provenex.ai">skulk@provenex.ai</a> &middot; <a href="https://provenex.ai">provenex.ai</a></p>
  <p style="margin-top: 1rem; font-size: 0.85rem; color: #888;">
    Each verdict in the response carries an <code>ed25519</code>-signed artifact under the
    <code>trial-2026-06</code> key (retrievable via <code>/v1/verdicts</code>) so the closure
    is verifiable even after this HTML report is forwarded onward.
  </p>
</footer>
</body>
</html>
"""


def main() -> int:
    args = sys.argv[1:]
    if len(args) != 2:
        print(
            "usage: render-verdict.py <verdict.json|-> <verdict.html|->\n"
            "  Use - for stdin / stdout.",
            file=sys.stderr,
        )
        return 2

    src, dst = args
    if src == "-":
        verdict = json.load(sys.stdin)
        source_label = "(stdin)"
    else:
        with open(src, "r", encoding="utf-8") as f:
            verdict = json.load(f)
        source_label = src

    html = render(source_label, verdict)

    if dst == "-":
        sys.stdout.write(html)
    else:
        with open(dst, "w", encoding="utf-8") as f:
            f.write(html)
        print(f"  report written: {dst}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
