#!/usr/bin/env bash
# Provenex trial — sample telemetry runner.
#
# After signing up at https://provenex.ai/trial you'll get an email with
# your API key. Set it as PROVENEX_API_KEY (env var or pass on the
# command line), then run this script to post 7 curated OTLP/JSON
# traces and see real verdicts come back from the engine.
#
# Each trace is a known shape — the comments below describe what
# Provenex should fire (or correctly clear) on each.
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

# Find the script's own dir (works whether you cd in or run via path).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

post() {
  local fixture="$1"
  local description="$2"
  local expected="$3"

  printf "\n──────────────────────────────────────────────────────\n"
  printf "  %s\n" "$description"
  printf "  expected: %s\n" "$expected"
  printf "──────────────────────────────────────────────────────\n"

  curl -s -X POST "$URL/v1/receipts" \
    -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    --data-binary "@$SCRIPT_DIR/$fixture" \
    | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except Exception as e:
    print(f'  bad response: {e}')
    sys.exit()
red = d.get('red_verdicts', 0)
egress = d.get('receipts_ingested', 0)
print(f'  egress points evaluated: {egress}')
print(f'  red verdicts fired:      {red}')
for v in d.get('verdicts', []):
    binding = v.get('binding_reason') or '(no binding)'
    risk = v.get('risk') or '?'
    explanation = (v.get('explanation') or '').split('—')[0].strip()[:90]
    print(f'    • {binding} / {risk}')
    if explanation:
        print(f'      {explanation}')
"
}

cat <<'BANNER'

╔══════════════════════════════════════════════════════════════════╗
║  Provenex trial — sample telemetry runner                        ║
║                                                                  ║
║  Each block posts one OTLP trace to your trial endpoint and      ║
║  reports what Provenex caught. Expected outcomes are noted so    ║
║  you can match against reality.                                  ║
╚══════════════════════════════════════════════════════════════════╝
BANNER

post "01_echoleak_breach.otlp.json" \
  "[1/7] EchoLeak (CVE-2025-32711) — M365 Copilot reconstruction" \
  "Red, cross-zone-composition / high — the headline attacker-engineered catch"

post "02_devin_secrets_leak.otlp.json" \
  "[2/7] Devin secrets leak (Cognition disclosure) — coding agent reconstruction" \
  "≥2 Red verdicts, cross-zone-composition / high — multi-egress exfil shape"

post "03_slack_ai_exfil.otlp.json" \
  "[3/7] Slack AI exfil (PromptArmor disclosure) — public channel poisoning" \
  "Red, cross-zone-composition / high — workspace-indexed Slack AI reads a poisoned public channel and exfils via link-unfurl"

post "04_bing_greshake.otlp.json" \
  "[4/7] Bing-Greshake (Greshake et al. 2023) — earliest documented indirect prompt injection" \
  "Red, cross-zone-composition / high — attacker page in an adjacent tab steers Bing chat into reading session history and exfiltrating via markdown image"

post "05_cursor_nomshub.otlp.json" \
  "[5/7] Cursor NomShub (Straiker AI) — supply-chain shape for coding agents" \
  "≥2 Red verdicts, cross-zone-composition / high — malicious .cursorrules in a fetched repo drives credential cache read + device-code tunnel"

post "06_delayed_exfil_day0_write.otlp.json" \
  "[6/7] Delayed exfil — Day 0 write (no egress yet)" \
  "0 Red verdicts — this is the poisoning step; nothing leaves yet"

post "07_delayed_exfil_day2_egress.otlp.json" \
  "[7/7] Delayed exfil — Day 2 egress (closure crosses batches)" \
  "Red, high-risk-resource-egress / high — cross-batch lineage walks back to the Day 0 write; the patient-attacker shape no UEBA can see"

printf "\n──────────────────────────────────────────────────────\n"
printf "  Verdicts persisted to your audit log.\n"
printf "  Retrieve them at any time with:\n\n"
printf "    curl -H \"Authorization: Bearer \$PROVENEX_API_KEY\" \\\\\n"
printf "      $URL/v1/verdicts?limit=20 | python3 -m json.tool\n\n"
printf "  Trial expires 30 days from your signup.\n"
printf "  Onboarding doc: https://provenex.ai/docs/onboarding\n"
printf "──────────────────────────────────────────────────────\n"
