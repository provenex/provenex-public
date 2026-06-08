# Installing `provenex-ingest`

The open-source customer-side ingestor. Source is public and auditable; the binary you install is built from that source. **We never email binaries**. every install path below pulls from a verifiable source.

Three install methods, pick whichever your stack prefers.

## Path 1. Cargo (Rust toolchain)

```bash
cargo install --git https://github.com/provenex/provenex-ingest provenex-ingest
```

That downloads the source, compiles it locally, drops the binary at `~/.cargo/bin/provenex-ingest`. Your security team can audit the source between `git clone` and `cargo install` if they prefer the explicit version:

```bash
git clone https://github.com/provenex/provenex-ingest.git
cd provenex-ingest
# audit the source here: it's ~600 lines of Rust
cargo install --path . --bin provenex-ingest
```

**Requires:** Rust 1.86+ (any recent stable). Install via [rustup](https://rustup.rs) if you don't have it.

## Path 2. Docker

```bash
docker pull ghcr.io/provenex/provenex-ingest:latest
```

The image is built reproducibly from the same source via GitHub Actions; the digest is verifiable against the release manifest. Run it as a sidecar to your OTel Collector or as a one-shot CLI:

```bash
# one-shot CLI: send a file
docker run --rm \
  -v $(pwd):/data \
  -e PROVENEX_API_KEY=pvx_trial_xxx \
  ghcr.io/provenex/provenex-ingest:latest \
  send /data/my-trace.otlp.json

# listen as an OTLP receiver
docker run -d --name provenex-ingest \
  -p 4318:4318 \
  -e PROVENEX_API_KEY=pvx_trial_xxx \
  -e PROVENEX_HMAC_SALT=your-tenant-salt \
  -e PROVENEX_MODE=hash \
  ghcr.io/provenex/provenex-ingest:latest \
  listen
```

## Path 3. One-line shell installer

For developers who'd rather not install Rust or Docker. The installer detects your OS+architecture (darwin x86/arm, linux x86/arm) and downloads the matching prebuilt binary from the [Releases page](https://github.com/provenex/provenex-ingest/releases):

```bash
curl -fsSL https://signup.provenex.ai/install | sh
```

The script:
1. Detects your `uname` → picks the right release artifact
2. Downloads the tarball + the `.shasum`
3. Verifies the checksum
4. Extracts the binary to `~/.local/bin/provenex-ingest` (or `/usr/local/bin/` if run as root)
5. Prints a `provenex-ingest --help` to confirm it works

Want to inspect the install script before running it? It's at https://signup.provenex.ai/install; view it as a regular URL, then run when you're happy.

## Verifying the binary

Every Release artifact ships with a SHA-256 checksum. After installing:

```bash
# version is embedded
provenex-ingest --help | head -1

# expected SHA-256 for your release (check https://github.com/provenex/provenex-ingest/releases)
shasum -a 256 $(which provenex-ingest)
```

The Releases page is the canonical source for "what hash should I expect for version X on Y platform."

## What the binary does

In order of capability, lightest first:

```
provenex-ingest send <file>            # post one OTLP/JSON file (curl-equivalent)
provenex-ingest batch <dir/>           # post every *.otlp.json in a directory
provenex-ingest watch <dir/>           # live-tail a directory; post new files as they arrive
provenex-ingest listen [--bind addr]   # OTLP/HTTP receiver; forwards to api.provenex.ai
```

Every subcommand respects the same config flags:

| Flag | Env var | Default | Purpose |
|---|---|---|---|
| `--api-key` | `PROVENEX_API_KEY` | (required) | Your trial Bearer token |
| `--upstream` | `PROVENEX_UPSTREAM` | `https://api.provenex.ai` | Where to forward |
| `--mode` | `PROVENEX_MODE` | `plain` | `plain` or `hash` |
| `--salt` | `PROVENEX_HMAC_SALT` |; | Per-tenant HMAC salt; required when `--mode hash` |
| `--concurrent` |; | 4 | Max parallel uploads (for batch/watch) |

## What the binary contains (and doesn't)

**Contains:**
- OTLP/JSON parsing
- HMAC-SHA-256 over content fields (when `--mode hash`)
- HTTPS forwarding to the upstream
- Directory scanning + polling for batch/watch modes
- An axum HTTP server for listen mode

**Does NOT contain:**
- Any Provenex zone classification rules
- The closure walker or archetype catalog (those stay on the server)
- Any policy configuration
- Any customer-specific data (state is in-memory only; nothing persisted to disk)

A reverse-engineer of this binary reveals nothing proprietary; by design. The catch surface lives entirely on the server side at `api.provenex.ai`. The binary is a thin, auditable, content-redacting forwarder.

## Air-gapped customers

If you can't reach `crates.io` / `ghcr.io` / `github.com` from production:

- Build offline from a vendored copy: `cargo vendor && cargo build --offline --release`
- Air-gap-mirror the Docker image to your internal registry: `docker save . . | ssh registry docker load`
- For paid/enterprise deployments, we also ship a signed binary tarball via secure transfer (contact sales)

## Updating

```bash
# cargo
cargo install --git https://github.com/provenex/provenex-ingest provenex-ingest --force

# docker
docker pull ghcr.io/provenex/provenex-ingest:latest
docker restart provenex-ingest

# shell installer (re-run: it overwrites)
curl -fsSL https://signup.provenex.ai/install | sh
```

The trial-launch binary version is `v0.1.x`. We follow semver for the public CLI surface (subcommand names, flags); breaking changes go to a major version bump and we email all active trial customers before.

## Reporting issues

- Public repo issues: https://github.com/provenex/provenex-ingest/issues
- Security disclosures: security@provenex.ai (PGP key: TBD)
