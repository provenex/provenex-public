# Provenex public

The public-facing assets for [Provenex](https://provenex.ai) trial customers.

Provenex catches the class of AI-agent breach that DLP, IAM, prompt-injection classifiers, and AI-SPM tools structurally cannot see; the chain of authorized steps that adds up to a privileged action no human approved. Malicious or honest mistake, same mechanism.

## What's in this repo

### `samples/`. sample telemetry bundle

7 curated OTLP/JSON traces that customers can post against their trial endpoint to see real Red verdicts within 10 seconds of getting their API key:

| # | Trace | Catches |
|---|---|---|
| 1 | EchoLeak (CVE-2025-32711). M365 Copilot reconstruction | `cross-zone-composition` Red/High |
| 2 | Devin secrets leak; coding-agent reconstruction | `cross-zone-composition` Red/High (multi-egress) |
| 3 | Slack AI exfil. PromptArmor disclosure | `cross-zone-composition` Red/High |
| 4 | Bing-Greshake; first documented indirect prompt injection (2023) | `cross-zone-composition` Red/High |
| 5 | Cursor NomShub; coding-agent supply chain shape (Straiker AI) | `cross-zone-composition` Red/High (×3) |
| 6 | Delayed exfil Day 0; poisoned write | 0 Red (correct; write only) |
| 7 | Delayed exfil Day 2; cross-batch closure | `high-risk-resource-egress` Red/High |

Plus `try-me.sh`. a runner that posts all 7 in sequence and prints the verdict per trace.

### `docs/`. customer-facing documentation

- `onboarding.md`. get from API key to real Red verdicts in 10 minutes; per-framework quickstarts for LangChain, LlamaIndex, OpenAI SDK, Anthropic SDK, Bedrock, etc.
- `telemetry-checklist.md`. what OTel attributes to emit for best catch coverage; tiered by importance
- `install.md`. how to install the open-source `provenex-ingest` CLI (cargo / docker / shell installer)

These mirror the docs served at https://signup.provenex.ai/docs/* and are kept in sync.

## Running the sample bundle

You need a trial API key (sign up at https://provenex.ai for the free 30-day trial). Then:

```bash
git clone https://github.com/provenex/provenex-public.git
cd provenex-public/samples
PROVENEX_API_KEY=pvx_trial_xxxxxxxxxxxxxxxxxxxxxxxxxxxx ./try-me.sh
```

You'll see 9 Red verdicts persist to your audit log in ~10 seconds. Retrieve them at any time:

```bash
curl -H "Authorization: Bearer $PROVENEX_API_KEY" \
  https://api.provenex.ai/v1/verdicts?limit=20
```

## What's NOT in this repo

The Provenex engine itself; the closure walker, archetype catalogue, policy engine, classification heuristics. That stays server-side at `api.provenex.ai`. The open-source customer-side ingestor lives at [provenex/provenex-ingest](https://github.com/provenex/provenex-ingest).

## License

Apache 2.0; see [LICENSE](LICENSE).

## Contributing

Issues and PRs welcome on the bundled samples + docs. Bug reports on the engine itself should go through your trial dashboard's "Report an issue" link.

## Security

Disclosures: security@provenex.ai. We acknowledge within 1 business day and follow [security.txt](https://provenex.ai/.well-known/security.txt).
