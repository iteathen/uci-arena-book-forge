# Book Forge

Book Forge is the standalone Node.js producer for UCI Arena opening-book
snapshots. It owns ingestion, durable observations, optional Stockfish
qualification, bounded maintenance, deterministic compilation, validation, and
automatic publication. It does not import or call UCI Arena internals.

The default daemon continuously sips aggregate positions from the authenticated
Lichess Opening Explorer. It queries standard rapid/classical games in the
2000, 2200, and 2500 rating groups, advances a durable rarity/LCB-prioritized
frontier through ply 30, and feeds the same local Stockfish and snapshot
pipeline used by file sources. The token is read only from its configured file
and is never included in status, logs, task actions, or snapshot provenance.

Requires Node.js 24.15 or newer. Install the locked dependencies with
`npm ci`.

Quick integration bootstrap:

```powershell
node src/cli.mjs init --workspace E:\book-forge
node src/cli.mjs source add --workspace E:\book-forge --fixture bootstrap_v1
node src/cli.mjs daemon --workspace E:\book-forge --once
node src/cli.mjs status --workspace E:\book-forge --json
```

Manager consumes the same installed CLI through the versioned JSON API. Output
inspection uses a named id so workspace/config flags cannot be mistaken for
provider-owned output identity:

```powershell
node src/cli.mjs api outputs list --workspace E:\book-forge
node src/cli.mjs api outputs inspect --workspace E:\book-forge --id integration-0123456789abcdefabcd
```

Inspect or manually advance remote acquisition:

```powershell
node src/cli.mjs acquisition status --workspace E:\book-forge
node src/cli.mjs acquisition run --workspace E:\book-forge --max-requests 1
node src/cli.mjs acquisition retry-auth --workspace E:\book-forge
```

Acquisition is default-on, permits only one request at a time, waits at least
five seconds between requests, and persists a 2,000-request UTC daily budget.
HTTP 429 responses pause for at least one minute; authentication failures open
a visible six-hour circuit without stopping the daemon. Every refreshed
position atomically replaces its earlier cumulative totals, and overlap-domain
authority prevents a future Lichess PGN audit from double-counting Explorer
statistics.

Install the continuous worker as a per-user Windows logon task. Installation is
idempotent and starts it immediately:

```powershell
node src/cli.mjs startup install --workspace E:\book-forge
node src/cli.mjs startup status --workspace E:\book-forge
```

Task Scheduler runs a native Windows GUI-subsystem launcher, which starts the
foreground Node daemon with `CREATE_NO_WINDOW`, redirects its standard streams
to the Windows null device, and restarts every unexpected daemon exit with
exponential backoff from five seconds through five minutes. Task Scheduler
remains a second fallback if the launcher itself exits. Closing an interactive
terminal therefore cannot stop Book Forge. The task uses the current absolute
launcher, Node, CLI, workspace, optional config, and installed package root. To remove the startup entry
and end its scheduled instance, use `startup uninstall`. `daemon --detach`
remains available for temporary sessions that are not managed by Windows.

`pause` and `resume` are durable control commands. The daemon runs at low OS
priority and uses phase-specific resource permits. While `uci_arena_engine.exe`
is running, low-rate Explorer acquisition and bounded integration
publication stay enabled in courtesy mode. Stockfish analysis continues in
`background_sip`: no more than two one-thread workers, restricted to two CPU
sets in Windows' lowest reported efficiency class, tagged EcoQoS/idle priority,
and held to a 50-percent work/rest duty cycle. If heterogeneous CPU sets cannot
be proven, it falls back to one low-priority worker without guessed affinity.
A wider active analysis batch is interrupted and cleaned up within two seconds
when a foreground engine appears, then a later cycle resumes with the bounded
profile. File ingestion, qualified publication, and maintenance wait. Operator
pause, battery/power limits,
memory/disk pressure, and configured compiler/build processes stop every work
class. Additional Stockfish workers ramp only after sustained idle samples. A
75 GiB free-space floor and deterministic six-move per-position/two-million-
record export caps are enabled by default. Monthly maintenance consolidates
cohorts older than 24 months without losing source identity, drops obsolete
retired PV text, and retains four snapshot generations per channel. Publishing
identical content is a no-op. A transient Stockfish startup, interrogation, or
command timeout is contained to that analysis stage: workers are closed, the
bounded cycle report records the error, and maintenance plus later cycles
continue without treating partial analysis as qualified evidence. Unexpected
cycle-level failures also recover inside the continuous daemon, with a live
heartbeat and exponential retry from five seconds through five minutes;
one-shot runs and startup/lock/configuration failures remain fail-fast.

`status` includes the current acquisition frontier and request budget plus the
daemon phase, heartbeat, cycle timestamps, and bounded last-cycle report. The
native supervisor terminates a daemon whose heartbeat is stale for five
minutes, allowing Task Scheduler to restart it. Monthly `.pgn.zst` streaming is
reserved as a default-off audit source; it is not required for Explorer-backed
book growth and can never contribute overlapping counts to a publication.

The producer is Node-only. On Windows, an optional tiny native resource guard
adds Job Object cleanup, EcoQoS/very-low I/O priority, heterogeneous CPU-set
selection, battery state, and real input-idle telemetry—OS controls Node does
not expose:

```powershell
cmake -S vendor/background-service-runtime/native -B build/native
cmake --build build/native --config Release
```

Without that helper, Book Forge remains functional and conservatively uses the
portable low-priority, CPU, memory, disk, and priority-process controls.

## Package boundary and persistent data

The repository root is the Book Forge package root. Shared UCI Arena packages
are regular-file inputs pinned by `vendor/upstream.lock.json`; they never reach
into another checkout. The installed component is relocatable, uses its own
packaged dependency closure, and does not require Arena or Evidence Service
source.

`contracts/service-contract.json` is the installed public boundary. It binds
the component version, CLI, configuration and status schemas, capabilities,
startup ownership, status health smoke, data paths, and persistence policy.
UCI Arena Manager verifies it against the signed component manifest and keeps
its digest in the install receipt.

The workspace is deliberately separate from installed binaries. It contains
`catalog.sqlite`, observation shards, source records, the inbox, immutable
snapshots, published channel pointers, and locks/heartbeat state. Repair,
upgrade, startup removal, and default uninstall preserve this workspace so
expensive acquisition and qualification evidence is not lost. Explicit data
removal is a separate operator action. The configured token file is externally
owned and is never copied into or removed with the component.

The fixture is permanently marked `integration_only`; it can never enter the
qualified channel. On Windows, UCI Arena consumes the published integration
channel automatically on its next engine start. It resolves the workspace from
`BOOK_FORGE_ROOT`, or uses `E:\book-forge` when that variable is unset. The UCI
`BookFile`, `BookStatsFile`, and `BookPolicyFile` options remain explicit
operator overrides.

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
node src/cli.mjs qualification record --workspace E:\book-forge --content 0123456789abcdef0123 --elo-lower-bound -3.2 --uci-regressions 0 --evidence E:\evidence\book-candidate.json
```

Sources remain independently removable without replaying other PGNs:

```powershell
node src/cli.mjs source quarantine 12 --workspace E:\book-forge
node src/cli.mjs source restore 12 --workspace E:\book-forge
```
