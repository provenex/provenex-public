# Penny River: 1,000 individually cleared pennies

This synthetic matched-twin evidence pack demonstrates a collection-level
payment anomaly that a per-transaction limit cannot express:

- 1,000 independent, controller-stamped **settled** payments;
- each payment is USD 0.01 and individually `PolicyCleared` under a USD 1.00
  per-action rule;
- all 1,000 settlements converge on one fictional destination in less than 24
  hours, totalling USD 10.00;
- 10 duplicate processor deliveries are present but dedupe back to the same
  1,000 settlements;
- 10 `stated` attempts are present but never counted as money moved.

The unsafe arm carries an explicit `target.verified=false` stamp from the
trusted settlement controller, so the aggregate advisory says `Review`. The
shape-identical clean arm changes only that controller stamp to `true`, so the
same convergence remains visible but says `Expected` and emits no finding.

The exact minimized result is in
[`penny-river-1000.report.json`](penny-river-1000.report.json).

## Frozen result

| Observation | Unverified arm | Verified twin |
|---|---:|---:|
| Registered financial actions | 1,020 | 1,020 |
| Settlement receipts sampled | 1,010 | 1,010 |
| Unique settlements after replay dedupe | 1,000 | 1,000 |
| Stated-only attempts excluded | 10 | 10 |
| Individually `PolicyCleared` | 1,000 | 1,000 |
| Individually Red | 0 | 0 |
| Aggregate disposition | `Review` | `Expected` |
| Aggregate advisory findings | 1 | 0 |

This is the point of the demonstration: changing aggregate destination
evidence changes the **report-only** disposition while the 1,000 signed
per-action decision semantics remain identical. Provenex does not rewrite,
re-sign, or block those decisions from this projection.

The engine reports 20 local pivot receipt IDs and discloses that another 980
were truncated by the evidence-list privacy/resource cap. It reports zero
dropped receipts and zero dropped groups. Raw destination and obligation values
are not copied into the exported advisory.

## Generate the exact OTLP twins

The generated fixtures are about 1.3 MB each, so this repository commits the
small deterministic generator and the frozen hashes rather than two large,
mostly repeated JSON files.

```sh
output_dir="$(mktemp -d)"
python3 generate_fixtures.py --output-dir "$output_dir"
python3 -m json.tool "$output_dir/manifest.json"
```

With the default parameters, the manifest must report:

- unsafe SHA-256
  `b4eefa56a318912974f5f23bfdfa2c4acf77436b4e691e13dc32ce6939a79da2`;
- verified SHA-256
  `ad7e1e63a339e744fd1d8c105e4d35d03db3e50af0ccc48f950c4f3f9f12013b`;
- normalized matched-shape SHA-256
  `8e69e4f076168b09fa51a95a69aeb94e3bf8748c726407514851f346c1f165a0`.

The generator replaces every `target.verified` value with one sentinel and
asserts that the normalized documents are byte-identical. The manifest pins
1,020 occurrences per arm, so the matched difference includes the settled,
duplicate-delivery, and stated-only records rather than a selected subset.

## Engine reproduction boundary

The frozen result was produced on 2026-08-28 by Provenex engine source commit
`aaf195784c538e2ab839dc4aa48a134ec6a33c3a`. In a private engine checkout, the
end-to-end regression is:

```sh
cargo test --test penny_river_flagship -- --nocapture
```

That test invokes this public generator, ingests both OTLP files through the
normal adapter while trusting only `penny-river-settlement-controller` for
typed action-context stamps, applies the USD 1.00 per-action rule, compares all
signed decision-bearing fields, projects the aggregate advisory, checks its
privacy/cap disclosures, and byte-pins the semantic JSON result above.

This public mirror does **not** contain the private Provenex engine or Rust test
harness. A public reader can independently generate and inspect the matched
OTLP documents and verify their hashes, but cannot independently rerun the
Provenex assessment from this repository alone.

## Claim boundary

This is repository-authored synthetic telemetry and a deterministic mechanism
test. It is not a measured fraud rate, false-positive rate, production incident,
or proof that a bank account is attacker-owned. A `settled` stamp means the
trusted controller reported settlement; this pack does not prove bank
ownership, loss, reversal, recovery, or customer impact. `Review` means the
observed settled convergence plus explicit lack of destination verification
merits investigation. It does not itself declare fraud.
