# F02 follow-up: Book Forge public source and CI authority

Scope: reconcile the Book Forge-owned repository boundary at base `319bbd8be3869aca982d726404046c2e91156b79`, after [Installer PR #219](https://github.com/iteathen/uci-arena-installer/pull/219) merged as `254208833c3c903dd5fe57674c5cc297582207e8`. This is a specification correction, not release authorization or asset-content security approval.

Cause: the active boundary still declared private visibility and disabled hosted CI after the owner-directed public-source/read-only-CI transition. The checked-in automation validator already permits read-only CI and requires separate manual release dispatch; stale specification text created conflicting authority.

## Reasoning and admissible solutions

Affected suite objectives: G-O1 trustworthy chess feedback and G-O2 practical operation. Relevant premises: G-P4/G-P6/G-P9/G-P21/G-P23/G-P28 and B-P2/B-P5. Assertions: G-A3/G-A7/G-A26 and B-A10. Targets: G-T4/G-T6/G-T9/G-T12/G-T14 and B-T4/B-T6/B-T9/B-T10. G-D3 constrains convenience that weakens operator/credential authority; G-D4 rejects a local shortcut that changes composed contract truth; G-D8 and B-D4 prohibit unqualified publication/strength claims. No actual conflict requires sacrificing trust for public source or useful CI.

| Candidate | Benefit and cost | Disposition |
| --- | --- | --- |
| A: correct this owner's active visibility/CI specification; distinguish public candidate bytes from authorization/qualification | Truthful current authority, no runtime migration; preserves exact release gates | Selected |
| B: move candidates to separately approved private transport while retaining public source/CI | Supports a real embargo, but needs new transport/access ownership and justification | Reserve only for separately demonstrated confidentiality need |
| C: privatize source and disable CI | Recreates old posture without proving assets safe; contradicts the current owner direction | Rejected |
| D: remove release/draft/provenance restrictions because source is public | Simplifies publication by collapsing independent trust/qualification gates | Rejected: violates hard authority boundaries |

Implementation: only `specs/repository_boundary_v1.yaml` and this record. Existing contracts, payload identities, SBOM/test receipts, source/workflow/ref/trigger/DSSE/Sigstore verification, three-asset remote digest checks, independent book qualification, and Installer-only suite promotion remain owned by their existing contracts. Historical private/no-CI text is preserved in the [base specification](https://github.com/iteathen/uci-arena-book-forge/blob/319bbd8be3869aca982d726404046c2e91156b79/specs/repository_boundary_v1.yaml), not rewritten in historical records.

## Evidence and qualification boundary

Observed 2026-10-13 through GitHub API: repository is public; [base CI](https://github.com/iteathen/uci-arena-book-forge/blob/319bbd8be3869aca982d726404046c2e91156b79/.github/workflows/ci.yml) runs PR/declared branch-push qualification with `contents: read`, no persisted checkout credentials, and no release job. [Base release workflow](https://github.com/iteathen/uci-arena-book-forge/blob/319bbd8be3869aca982d726404046c2e91156b79/.github/workflows/component-release.yml) is dispatch-only and requires an exact-head, empty, non-draft prerelease before upload, then verifies exactly three asset names, sizes and SHA-256 digests. Published Book Forge/opening-book prereleases are non-draft; public bytes do not grant stable or strength authority. No releases, settings, credentials, signing operations, workflow permissions, or runtime code changed.

Validation: required specification preflight; vendor-lock, repository-boundary and automation checks; lockfile npm audit; YAML parsing and semantic comparison of unchanged contracts/rules/validation gates. Exact PR-head CI and fresh non-author review must qualify integration and are recorded on the PR. Evidence is project-controlled internal qualification. Windows native helper execution, book strength, complete historical asset/secret/license exposure review and stable suite readiness are not established here.

Next bounded task: the Evidence Service-owned counterpart. Syzygy's private-intake/draft conflict remains a separate owner/security review; do not weaken its guard or publish drafts.
