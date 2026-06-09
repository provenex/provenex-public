#!/usr/bin/env bash
# Provenex trial; sample telemetry runner.
#
# After signing up at https://provenex.ai/trial you'll get an email with
# your API key. Set it as PROVENEX_API_KEY (env var or pass on the
# command line), then run this script to post 12 curated OTLP/JSON
# traces and see what Provenex catches.
#
# Each trace is a reconstruction of a named, publicly disclosed
# production AI-agent breach (through January 2026) plus a two-trace
# patient-attacker scenario showing cross-batch lineage.
#
# Usage:
#   PROVENEX_API_KEY=pvx_trial_... ./try-me.sh
#   # or
#   ./try-me.sh pvx_trial_...

set -u

KEY="${PROVENEX_API_KEY:-${1:-}}"
URL="${PROVENEX_API_URL:-https://api.provenex.ai}"

if [[ -z "$KEY" ]]; then
  echo "error: set PROVENEX_API_KEY (env or arg)" >&2
  echo "       see your trial signup email for the value" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Where the script writes per-trace verdict JSON + HTML reports.
# Overridable via PROVENEX_REPORTS_DIR=... if you want a different path.
REPORTS_DIR="${PROVENEX_REPORTS_DIR:-$SCRIPT_DIR/reports}"
mkdir -p "$REPORTS_DIR"

# Pass --no-report on the command line to skip HTML rendering entirely.
# Otherwise render-verdict.py (sitting alongside this script) is invoked
# on every successful response. The renderer is plain Python 3 (stdlib
# only), so there is nothing to install.
RENDER_HTML=1
for arg in "$@"; do
  case "$arg" in
    --no-report) RENDER_HTML=0 ;;
  esac
done

post() {
  local fixture="$1"
  local description="$2"
  local expected="$3"
  local stem="${fixture%.otlp.json}"
  local response_json="$REPORTS_DIR/${stem}.json"
  local report_html="$REPORTS_DIR/${stem}.html"

  printf "\n──────────────────────────────────────────────────────\n"
  printf "  %s\n" "$description"
  printf "  expected: %s\n" "$expected"
  printf "──────────────────────────────────────────────────────\n"

  curl -s -X POST "$URL/v1/receipts" \
    -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    --data-binary "@$SCRIPT_DIR/$fixture" \
    -o "$response_json"

  python3 -c "
import sys, json
try:
    with open('$response_json') as f:
        d = json.load(f)
except Exception as e:
    print(f'  bad response: {e}')
    sys.exit()
findings = d.get('findings', []) or []
if findings:
    red = d.get('red_verdicts', 0)
    print(f'  Found {red} unsafe chain(s).')
    for i, f in enumerate(findings, 1):
        print(f'  [{i}] Agent: {f.get(\"agent\", \"?\")}')
        for r in (f.get('retrieved', []) or [])[:3]:
            print(f'      Retrieved: {r.get(\"label\", \"?\")}')
        aa = f.get('attempted_action', {}) or {}
        print(f'      Attempted action: {aa.get(\"label\", \"?\")}')
        wf = (f.get('why_flagged') or '').strip()
        if wf:
            print(f'      Why flagged: {wf}')
else:
    red = d.get('red_verdicts', 0)
    egress = d.get('receipts_ingested', 0)
    print(f'  egress points evaluated: {egress}')
    print(f'  red verdicts fired:      {red}')
    for v in d.get('verdicts', []):
        binding = v.get('binding_reason') or '(no binding)'
        risk = v.get('risk') or '?'
        explanation = (v.get('explanation') or '').split(';')[0].strip()[:90]
        print(f'    - {binding} / {risk}')
        if explanation:
            print(f'      {explanation}')
"

  if [ "$RENDER_HTML" = "1" ] && [ -f "$response_json" ]; then
    python3 "$SCRIPT_DIR/render-verdict.py" \
      "$response_json" "$report_html" 2>&1 \
      | sed 's/^/  /'
  fi
}

cat <<'BANNER'

╔══════════════════════════════════════════════════════════════════╗
║  Provenex trial; sample telemetry runner                         ║
║                                                                  ║
║  12 reconstructions of named production AI-agent breaches        ║
║  disclosed through January 2026, plus a 2-trace patient-attacker ║
║  scenario showing cross-batch lineage.                           ║
║                                                                  ║
║  Each block posts one OTLP trace to your trial endpoint and      ║
║  reports what Provenex caught. Expected outcomes are noted so    ║
║  you can match against reality.                                  ║
╚══════════════════════════════════════════════════════════════════╝
BANNER

post "01_echoleak_breach.otlp.json" \
  "[01/12] EchoLeak (CVE-2025-32711, Jun 2025); M365 Copilot reconstruction" \
  "Red, cross-zone-composition / high; the headline attacker-engineered catch"

post "02_cursor_nomshub.otlp.json" \
  "[02/12] Cursor NomShub (Straiker AI, 2025); supply-chain shape for coding agents" \
  "≥2 Red verdicts, cross-zone-composition / high; malicious .cursorrules in a fetched repo drives credential cache read + device-code tunnel"

post "03_curxecute_cursor_mcp.otlp.json" \
  "[03/12] CurXecute (CVE-2025-54135, Jul 2025); Cursor + Slack MCP RCE" \
  "Red, cross-zone-composition / high; Slack message rewrites ~/.cursor/mcp.json + auto-execs shell"

post "04_agentflayer_chatgpt_connectors.otlp.json" \
  "[04/12] AgentFlayer (Zenity Labs, Aug 2025); ChatGPT Connectors zero-click" \
  "Red, cross-zone-composition / high; poisoned Drive doc -> secret search -> image-URL exfil"

post "05_forcedleak_salesforce_agentforce.otlp.json" \
  "[05/12] ForcedLeak (Noma Labs, Sep 2025, CVSS 9.4); Salesforce Agentforce" \
  "Red, cross-zone-composition / high; Web-to-Lead form injection exfils CRM via CSP-allowed partner domain"

post "06_shadowleak_chatgpt_deep_research.otlp.json" \
  "[06/12] ShadowLeak (Radware, Sep 2025); ChatGPT Deep Research" \
  "Red, cross-zone-composition / high; attacker email drives mailbox search + server-side POST exfil"

post "07_notion3_pdf_exfil.otlp.json" \
  "[07/12] Notion 3.0 PDF exfil (CodeIntegrity, Sep 2025); the 'lethal trifecta'" \
  "Red, cross-zone-composition / high; PDF white-on-white inject + workspace read + outbound search query"

post "08_camoleak_github_copilot.otlp.json" \
  "[08/12] CamoLeak (CVE-2025-59145, Oct 2025); GitHub Copilot Chat" \
  "≥2 Red verdicts, cross-zone-composition / high; PR-comment inject reads private repo; Camo image URLs exfil"

post "09_cometjacking_perplexity.otlp.json" \
  "[09/12] CometJacking (LayerX, Oct 2025); Perplexity Comet AI browser" \
  "Red, cross-zone-composition / high; URL ?collection= param fires connector exfil to attacker POST"

post "10_anthropic_mcp_git_rce.otlp.json" \
  "[10/12] Anthropic MCP-Git RCE (CVE-2025-68143/4/5, Jan 2026)" \
  "Red, cross-zone-composition / high; repo README chains git_init + git_diff arg-injection + shell exec"

post "11_delayed_exfil_day0_write.otlp.json" \
  "[11/12] Delayed exfil; Day 0 write (patient-attacker setup, no egress yet)" \
  "0 Red verdicts; this is the poisoning step; nothing leaves yet"

post "12_delayed_exfil_day2_egress.otlp.json" \
  "[12/12] Delayed exfil; Day 2 egress (closure crosses batches)" \
  "Red, high-risk-resource-egress / high; cross-batch lineage walks back to the Day 0 write; the patient-attacker shape no UEBA can see"

printf "\n──────────────────────────────────────────────────────\n"
printf "  Done. Verdicts persisted to your audit log.\n\n"
if [ "$RENDER_HTML" = "1" ]; then
  printf "  HTML reports + raw JSON written to:\n"
  printf "    %s/\n\n" "$REPORTS_DIR"
  printf "  Open any one in your browser, e.g.:\n"
  printf "    open %s/01_echoleak_breach.html   # macOS\n" "$REPORTS_DIR"
  printf "    xdg-open %s/01_echoleak_breach.html   # linux\n\n" "$REPORTS_DIR"
fi
printf "  Retrieve the full audit log at any time:\n\n"
printf "    curl -H \"Authorization: Bearer \$PROVENEX_API_KEY\" \\\\\n"
printf "      $URL/v1/verdicts?limit=20 | python3 -m json.tool\n\n"
printf "  Trial expires 30 days from your signup.\n"
printf "  Onboarding doc: https://signup.provenex.ai/docs/onboarding\n"
printf "  Questions / feedback: skulk@provenex.ai\n"
printf "──────────────────────────────────────────────────────\n"
