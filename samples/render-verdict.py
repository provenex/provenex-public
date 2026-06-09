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

Visual smoke note: this renderer LEADS with the narrative `findings[]` field
emitted by the engine (humanized agent + retrieved sources + attempted action
+ why_flagged sentence). If `findings[]` is absent or empty (older engine
response shape), it falls back to the legacy binding_reason-headline layout
so a customer running an older response still sees something sensible.
"""
from __future__ import annotations

import datetime as _dt
import html as _html
import json
import sys


def _esc(s: object) -> str:
    return _html.escape(str(s) if s is not None else "", quote=True)


def _risk_class(risk: str) -> str:
    r = (risk or "").lower()
    if r in ("high", "medium", "low"):
        return r
    return "unknown"


def render_finding_card(f: dict, idx: int, vd: dict | None) -> str:
    """Narrative-lead card. Headline = why_flagged. Chips at bottom carry
    binding_reason / risk / correlation_key for SOC tooling."""
    agent = f.get("agent") or "(unknown agent)"
    why = f.get("why_flagged") or ""
    retrieved = f.get("retrieved") or []
    attempted = f.get("attempted_action") or {}
    attempted_label = attempted.get("label") or "(unknown destination)"
    attempted_uri = attempted.get("uri") or ""

    # Footer chips come from the paired engineer-facing verdict entry (if any).
    binding = (vd.get("binding_reason") if vd else None) or "(unclassified)"
    risk = (vd.get("risk") if vd else None) or "?"
    correlation = (vd.get("correlation_key") if vd else None) or "?"
    risk_cls = _risk_class(risk)

    retrieved_items = []
    for r in retrieved:
        r_label = r.get("label") or "(unlabeled)"
        r_uri = r.get("uri") or ""
        retrieved_items.append(
            f'<li class="retrieved-item">'
            f'<div class="retrieved-label">{_esc(r_label)}</div>'
            f'<div class="retrieved-uri">{_esc(r_uri)}</div>'
            f"</li>"
        )
    retrieved_html = (
        f'<div class="finding-section-label">Retrieved:</div>'
        f'<ul class="retrieved-list">{"".join(retrieved_items)}</ul>'
        if retrieved_items
        else ""
    )

    return (
        f'<div class="finding-card">'
        f'<div class="card-header">'
        f'<span class="finding-agent">{_esc(agent)}</span>'
        f'<span class="idx">#{idx + 1}</span>'
        f"</div>"
        f'<p class="finding-why">{_esc(why)}</p>'
        f"{retrieved_html}"
        f'<div class="finding-section-label">Attempted action:</div>'
        f'<div class="attempted-action attempted-action-{risk_cls}">'
        f'<div class="attempted-action-label">{_esc(attempted_label)}</div>'
        f'<div class="attempted-uri">{_esc(attempted_uri)}</div>'
        f"</div>"
        f'<div class="card-footer-chips">'
        f'<span class="chip chip-binding">{_esc(binding)}</span>'
        f'<span class="chip chip-risk chip-risk-{risk_cls}">{_esc(risk)}</span>'
        f'<span class="chip chip-correlation">{_esc(correlation)}</span>'
        f"</div>"
        f"</div>"
    )


def render_legacy_card(vd: dict, idx: int) -> str:
    """Original layout: binding_reason headline, risk chip prominent.
    Used when the engine response carries no findings[] (older shape)."""
    binding = vd.get("binding_reason") or "(unclassified)"
    risk = vd.get("risk") or "?"
    key = vd.get("correlation_key") or "?"
    explanation = vd.get("explanation") or ""
    return (
        f'<div class="card">'
        f'<div class="card-header">'
        f'<span class="binding">{_esc(binding)}</span>'
        f'<span class="risk risk-{_esc(risk.lower())}">{_esc(risk)}</span>'
        f'<span class="idx">#{idx + 1}</span></div>'
        f'<p class="explanation">{_esc(explanation)}</p>'
        f'<p class="key">correlation: <code>{_esc(key)}</code></p>'
        f"</div>"
    )


_STYLE = """
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 920px; margin: 2rem auto; padding: 0 1rem; color: #1f1f1f; line-height: 1.55; background: #fafafa; }
  h1 { font-size: 1.7rem; margin: 0 0 .3rem; }
  h2 { font-size: 1.1rem; margin: 2rem 0 .8rem; padding-bottom: .25rem; border-bottom: 1px solid #ddd; color: #444; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 4px; font-weight: 700; font-size: 0.85rem; letter-spacing: .04em; margin-right: .5rem; }
  .badge-red { background: #d83b3b; color: #fff; }
  .badge-ok { background: #2c9c5e; color: #fff; }
  .meta { color: #666; margin: .25rem 0 1.5rem; font-size: 0.9rem; }
  .stats { display: flex; gap: 1.5rem; padding: 1rem 1.25rem; background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; margin: 1.5rem 0; }
  .stat { flex: 1; }
  .stat-label { font-size: 0.85rem; color: #666; text-transform: uppercase; letter-spacing: .04em; }
  .stat-value { font-size: 1.4rem; font-weight: 700; margin-top: 4px; }
  .card { background: #fff; border: 1px solid #e5e5e5; border-left: 4px solid #d83b3b; border-radius: 6px; padding: 1rem 1.25rem; margin: .75rem 0; }
  .card-header { display: flex; align-items: center; gap: .75rem; margin-bottom: .4rem; }
  .binding { font-weight: 700; font-family: ui-monospace, Menlo, monospace; font-size: 0.95rem; color: #d83b3b; }
  .risk { font-size: 0.75rem; padding: 2px 8px; border-radius: 999px; font-weight: 700; text-transform: uppercase; }
  .risk-high { background: #fee; color: #a00; }
  .risk-medium { background: #fff5d6; color: #9a6800; }
  .risk-low { background: #e6f4ea; color: #2c7a3f; }
  .risk-unknown { background: #eee; color: #555; }
  .idx { margin-left: auto; color: #888; font-family: ui-monospace, Menlo, monospace; font-size: 0.85rem; }
  .explanation { margin: .35rem 0; }
  .key { font-size: 0.85rem; color: #666; margin: .2rem 0 0; }
  code { background: #f0f0f0; padding: 1px 5px; border-radius: 3px; font-size: 0.88em; }
  pre { background: #1f1f1f; color: #e6e6e6; padding: 1rem 1.25rem; border-radius: 6px; overflow-x: auto; font-size: 0.85rem; line-height: 1.45; }
  details { margin: 1rem 0; }
  details summary { cursor: pointer; color: #5560b4; font-weight: 500; padding: .5rem 0; }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #ddd; color: #777; font-size: 0.9rem; }
  footer a { color: #5560b4; }
  .source-label { font-family: ui-monospace, Menlo, monospace; color: #444; font-size: 0.9rem; }
  .finding-card { background: #fff; border: 1px solid #e5e5e5; border-left: 4px solid #d83b3b; border-radius: 6px; padding: 1rem 1.25rem; margin: .75rem 0; }
  .finding-agent { display: inline-block; background: #eef1ff; color: #3a45a3; padding: 2px 8px; border-radius: 999px; font-family: ui-monospace, Menlo, monospace; font-size: 0.8rem; font-weight: 600; }
  .finding-why { font-size: 1.05rem; margin: .6rem 0 .8rem; color: #1f1f1f; line-height: 1.45; }
  .finding-section-label { font-size: 0.78rem; color: #666; text-transform: uppercase; letter-spacing: .05em; font-weight: 700; margin-top: .5rem; margin-bottom: .3rem; }
  .retrieved-list { list-style: none; padding: 0; margin: 0 0 .6rem; }
  .retrieved-item { padding: .35rem .6rem; background: #f7f8fa; border-left: 2px solid #c5c9d6; border-radius: 3px; margin-bottom: .3rem; }
  .retrieved-label { font-weight: 600; font-size: 0.92rem; color: #1f1f1f; }
  .retrieved-uri { font-family: ui-monospace, Menlo, monospace; font-size: 0.78rem; color: #888; margin-top: 2px; word-break: break-all; }
  .attempted-action { padding: .5rem .75rem; border-radius: 4px; margin-bottom: .8rem; background: #fee; border-left: 3px solid #d83b3b; }
  .attempted-action-high { background: #fee; border-left-color: #d83b3b; }
  .attempted-action-medium { background: #fff5d6; border-left-color: #c98a00; }
  .attempted-action-low { background: #e6f4ea; border-left-color: #2c7a3f; }
  .attempted-action-unknown { background: #eee; border-left-color: #888; }
  .attempted-action-label { font-weight: 600; color: #1f1f1f; font-size: 0.95rem; }
  .attempted-uri { font-family: ui-monospace, Menlo, monospace; font-size: 0.78rem; color: #777; margin-top: 2px; word-break: break-all; }
  .card-footer-chips { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .8rem; padding-top: .6rem; border-top: 1px dashed #e5e5e5; }
  .chip { font-family: ui-monospace, Menlo, monospace; font-size: 0.72rem; padding: 2px 7px; border-radius: 3px; background: #f0f0f0; color: #555; }
  .chip-binding { background: #f0f0f0; color: #444; }
  .chip-correlation { background: #f0f0f0; color: #555; }
  .chip-risk { font-weight: 700; text-transform: uppercase; letter-spacing: .03em; }
  .chip-risk-high { background: #fee; color: #a00; }
  .chip-risk-medium { background: #fff5d6; color: #9a6800; }
  .chip-risk-low { background: #e6f4ea; color: #2c7a3f; }
  .chip-risk-unknown { background: #eee; color: #555; }
"""


def render(source_label: str, verdict: dict, version: str = "py-render-2026-06") -> str:
    now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    red = verdict.get("red_verdicts") or 0
    tenant = verdict.get("tenant_id") or "(unknown)"
    verdicts = verdict.get("verdicts") or []
    findings = verdict.get("findings") or []

    badge = "RED" if red > 0 else "OK"
    badge_class = "badge-red" if red > 0 else "badge-ok"

    # Use the narrative layout whenever the response is from an engine that
    # KNOWS about findings (presence of the key, regardless of contents).
    # That keeps OK-state responses (findings=[]) using the new vocabulary
    # ("Chains found: 0") instead of falling back to the old "Red verdicts"
    # / "Egress points evaluated" labels.
    use_narrative = "findings" in verdict

    raw_pretty = json.dumps(verdict, indent=2, ensure_ascii=False)

    if use_narrative:
        # New narrative layout — leads with finding cards.
        n = len(findings)
        if red > 0:
            headline = f"We found {n} unsafe chain{'s' if n != 1 else ''}"
        else:
            headline = "No unsafe chains found in this trace"

        cards = []
        for i, f in enumerate(findings):
            vd = verdicts[i] if i < len(verdicts) else None
            cards.append(render_finding_card(f, i, vd))
        body_cards = "".join(cards)

        chains_value = str(n)
        stats_html = (
            f'<div class="stats">'
            f'<div class="stat"><div class="stat-label">Chains found</div>'
            f'<div class="stat-value">{_esc(chains_value)}</div></div>'
            f'<div class="stat"><div class="stat-label">Source</div>'
            f'<div class="stat-value source-label" style="font-size: 0.95rem; word-break: break-all;">{_esc(source_label)}</div></div>'
            f'<div class="stat"><div class="stat-label">Tenant</div>'
            f'<div class="stat-value" style="font-family: ui-monospace, Menlo, monospace; font-size: 0.95rem; word-break: break-all;">{_esc(tenant)}</div></div>'
            f"</div>"
        )

        findings_section = (
            f'<h2>Findings ({n})</h2>{body_cards}'
            if cards
            else '<h2>Findings (0)</h2><p style="color: #555; font-style: italic;">Closure walked clean; no unsafe chains on this trace.</p>'
        )
    else:
        # Legacy fallback — preserves the previous binding-reason-headline layout.
        headline = (
            (verdicts[0].get("binding_reason") if verdicts else None)
            or ("No red verdicts; closure walked clean." if red == 0 else "Cross-zone composition detected.")
        )
        receipts_ingested = verdict.get("receipts_ingested") or 0

        legacy_cards = [render_legacy_card(vd, i) for i, vd in enumerate(verdicts)]
        body_cards = "".join(legacy_cards)
        stats_html = (
            f'<div class="stats">'
            f'<div class="stat"><div class="stat-label">Egress points evaluated</div>'
            f'<div class="stat-value">{receipts_ingested}</div></div>'
            f'<div class="stat"><div class="stat-label">Red verdicts</div>'
            f'<div class="stat-value">{red}</div></div>'
            f'<div class="stat"><div class="stat-label">Tenant</div>'
            f'<div class="stat-value" style="font-family: ui-monospace, Menlo, monospace; font-size: 0.95rem; word-break: break-all;">{_esc(tenant)}</div></div>'
            f"</div>"
        )

        findings_section = (
            f'<h2>Verdicts ({len(verdicts)})</h2>{body_cards}'
            if legacy_cards
            else '<h2>Verdicts (0)</h2><p style="color: #555; font-style: italic;">Closure walked clean; no red verdicts on this trace.</p>'
        )

    header_meta = (
        f'<p class="meta">Source: <span class="source-label">{_esc(source_label)}</span> '
        f'&middot; Tenant: <span class="source-label">{_esc(str(tenant)[:8])}</span> '
        f'&middot; {now}</p>'
    )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Provenex verdict, {_esc(headline)}</title>
<style>{_STYLE}</style>
</head>
<body>
<header>
  <span class="badge {badge_class}">{badge}</span>
  <h1>{_esc(headline)}</h1>
  {header_meta}
</header>

{stats_html}

{findings_section}

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
