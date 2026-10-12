# Repository context: uci-arena-book-forge

Universal engineering and design guidance comes from the account-global `AGENTS.md`.

## Mission and ownership

UCI Arena Book Forge is the standalone opening-book production product. It owns source acquisition, Explorer/PGN ingestion, observation/frontier selection, qualification, overlap authority, compilation, bounded retention, immutable publication, daemon lifecycle, health/status, and Book Forge packaging.

## Decision reasoning

Before a substantive architecture, design, implementation-selection, or cross-component
decision, read `reasoning/component_graph_v1.yaml` plus the canonical suite methodology,
concern census, and suite graph at
`iteathen/uci-arena-installer/reasoning/README.md`,
`iteathen/uci-arena-installer/reasoning/concern_census_v1.yaml`, and
`iteathen/uci-arena-installer/reasoning/suite_graph_v1.yaml`.

Book coverage, acquisition volume, and producer convenience are mechanisms rather than
objectives; local decisions must trace to chess benefit, proving-ground value, usability, or a
hard authority gate. Accepted Book Forge specs/contracts remain behavior authority.

## Local routing

Before substantive work run:

```text
node tools/spec-preflight.mjs --task "<description>" --changed-files <likely paths>
```

Read the active specs returned by preflight. Repository-boundary/Manager/packaging/publication work also follows `specs/suite_lego_boundaries_v1.yaml` and the canonical suite architecture in `iteathen/uci-arena-installer`.

## Local constraints

The Engine consumes published books but does not own their production. Service source depends only on declared packages/runtime components and does not import private source from Engine, Evidence Service, Manager, Installer, or other sibling repositories.
