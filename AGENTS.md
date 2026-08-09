# UCI Arena Book Forge Agent Contract

UCI Arena Book Forge is the standalone opening-book production product. It owns source acquisition, Explorer/PGN ingestion, observation/frontier selection, qualification, overlap authority, compilation, bounded retention, immutable publication, daemon lifecycle, health/status, and Book Forge packaging. The engine consumes declared book artifacts without owning how they were produced.

## Required start

1. Read `.agents/core-standard.md`.
2. Before substantive planning, inspection, implementation, or validation run:

```text
node tools/spec-preflight.mjs --task "<description>" --changed-files <likely paths>
```

3. Read every active specification returned by preflight and rerun when touched paths change materially.
4. For repository-boundary, Manager integration, packaging, publication, or cross-project contract work, also read `specs/suite_lego_boundaries_v1.yaml` and the canonical suite architecture in `iteathen/uci-arena-installer`.

Do not preload old engine-owned book-production paths, historical extraction plans, or unrelated suite specs.

## Ownership and reuse

Current Book Forge specs/contracts own production behavior; suite architecture owns cross-repository responsibility. The engine is a consumer of published books, not a hidden production dependency.

Before adding a new ingestion path, qualification worker, frontier store, compiler path, publisher, daemon control, retention mechanism, or status owner, search the current Book Forge owners/specs first and reuse or extend the existing owner.

Service source may depend only on declared packages and explicit runtime components. It must never import UCI Arena Engine, Evidence Service, Manager, Installer, or another private source checkout. Cross-repository exchange uses published contracts and immutable artifacts.

## Credentials, provenance, and publication

Never read, print, summarize, hash, copy, log, package, or commit credential contents. A credential may cross an allowed boundary only as the external file path/reference defined by contract.

Published artifacts require explicit identity, provenance, checksum/integrity, compatibility, and bounded retention semantics. Source acquisition/provenance must remain distinguishable from book selection/qualification logic so one does not become hidden authority for the other.

## Execution and debugging

Keep acquisition, qualification, compilation, publication, and retention behind their owned boundaries. Long-running workflows should be resumable/idempotent where practical and make partial state/recovery visible.

For ambiguous source, overlap, qualification, compilation, or publication failures, preserve the original failure signature and trace raw expected-vs-actual evidence through the owning boundary before changing logic.

## Validation and integration

Run the smallest complete preflight-selected local owner/contract validation first. Publication/provenance, persisted state, destructive retention, public compatibility, and recovery-sensitive changes retain their stronger safeguards regardless of diff size.

Code changes are tested, committed and pushed on a branch, and opened as a draft PR. Before integration, inspect the complete diff, freeze the exact head, use guarded exact-head integration where supported, and verify the target result.

## Completion

Complete when the requested Book Forge outcome is evidenced, publication/provenance is trustworthy, the engine remains only a consumer of the declared artifact contract, and no material invalid partial production state remains.
