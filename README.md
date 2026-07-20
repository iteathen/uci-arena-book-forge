# Book Forge

Book Forge is the standalone Node.js producer for UCI Arena opening-book
snapshots. It owns ingestion, durable observations, optional Stockfish
qualification, bounded maintenance, deterministic compilation, validation, and
automatic publication. It does not import or call UCI Arena internals.

Requires Node.js 24.15 or newer. Install the locked dependencies with
`npm ci --prefix tools/book_forge`.

Quick integration bootstrap:

```powershell
node tools/book_forge/src/cli.mjs init --workspace E:\book-forge
node tools/book_forge/src/cli.mjs source add --workspace E:\book-forge --fixture bootstrap_v1
node tools/book_forge/src/cli.mjs daemon --workspace E:\book-forge --once
node tools/book_forge/src/cli.mjs status --workspace E:\book-forge --json
```

Install the continuous worker as a per-user Windows logon task. Installation is
idempotent and starts it immediately:

```powershell
node tools/book_forge/src/cli.mjs startup install --workspace E:\book-forge
node tools/book_forge/src/cli.mjs startup status --workspace E:\book-forge
```

Task Scheduler runs the foreground daemon directly, without a visible console,
and restarts it after failure. It uses the current absolute Node, CLI,
workspace, optional config, and repository paths. To remove the startup entry
and end its scheduled instance, use `startup uninstall`. `daemon --detach`
remains available for temporary sessions that are not managed by Windows.

`pause` and `resume` are durable control commands. The daemon runs at low OS
priority, starts with one persistent one-thread Stockfish worker, backs off on
memory/disk/priority-process pressure, and only ramps additional workers after
sustained idle samples. A 75 GiB free-space floor and deterministic six-move
per-position/two-million-record export caps are enabled by default. Monthly
maintenance consolidates cohorts older than 24 months without losing source
identity, drops obsolete retired PV text, and retains four snapshot generations
per channel. Publishing identical content is a no-op.

The producer is Node-only. On Windows, an optional tiny native resource guard
adds Job Object cleanup, EcoQoS/very-low I/O priority, battery state, and real
input-idle telemetry—OS controls Node does not expose:

```powershell
cmake -S tools/book_forge/native -B tools/book_forge/native/build
cmake --build tools/book_forge/native/build --config Release
```

Without that helper, Book Forge remains functional and conservatively uses the
portable low-priority, CPU, memory, disk, and priority-process controls.

The fixture is permanently marked `integration_only`; it can never enter the
qualified channel. Configure UCI `BookFile`, `BookStatsFile`, and
`BookPolicyFile` to the corresponding files under
`E:\book-forge\published\integration`.

For real data, use `source add <file.pgn|file.pgn.gz|file.pgn.zst>`. The daemon
idempotently ingests pending sources and publishes statistical integration
snapshots. Qualified publication remains blocked until every emitted move has
current Stockfish evidence and the registered match gates pass.

For unattended operation, place monthly `.pgn`, `.pgn.gz`, or `.pgn.zst`
files in `E:\book-forge\inbox`. The daemon waits for each file to stop changing,
deduplicates its SHA-256, then sends it through the same resumable ingestion
path as `source add`.

When an integration candidate has completed paired-color match and UCI
compatibility testing, register the immutable evidence digest against the
20-hex content suffix shown in its snapshot id. The next daemon cycle promotes
it automatically if the eval, rarity, LCB, Elo, and zero-regression gates all
pass:

```powershell
node tools/book_forge/src/cli.mjs qualification record --workspace E:\book-forge --content 0123456789abcdef0123 --elo-lower-bound -3.2 --uci-regressions 0 --evidence arena\results\book-candidate.json
```

Sources remain independently removable without replaying other PGNs:

```powershell
node tools/book_forge/src/cli.mjs source quarantine 12 --workspace E:\book-forge
node tools/book_forge/src/cli.mjs source restore 12 --workspace E:\book-forge
```
