# Book producer lifecycle

The Windows component declares `arena_provider_startup_control_v3` through the
existing `arena_provider_installer_integration_v1` manifest. Its CLI port is
`lifecycle install|uninstall|pre_replace|post_replace`; replacement operations
also require absolute `--previous-root` and `--replacement-root`. All operations
take the existing `--workspace` and `--config` arguments. Stdout contains one
`arena_provider_lifecycle_result_v1` document. No Installer journal, transaction
identifier, credential value, or private store is part of this port.

This Windows source candidate does not qualify Linux v3. The Linux package
continues to declare its existing v1 startup port and preserve the existing
standalone per-user systemd commands. Target selection is Book producer build
metadata; the emitted Installer integration schema is unchanged.

The neutral ingress opens no Catalog constructor. After positive task/daemon
quiescence, restoration to the admitted immutable0.4.4 payload may reverse only
the producer-owned schema4-to5 transient daemon identity column and marker in
one SQLite transaction. Historical tables remain unchanged. Unknown schemas,
column definitions or live/unverifiable retained identities fail without change.
Readiness requires actual fresh daemon state, heartbeat and exact OS process
incarnation, separately from Task registration, enablement or running intent.
`started` alone is never activity evidence. A stopped/failed phase in a live
process is still a drain obstacle. `ready` and `safe_inactive` obey the neutral
operation invariants; unknown activity never becomes `safe_inactive`.

Before any gate, task or run effect, Book saves its own bounded original
definition, exact Exec action, enablement and observed running intent in
`.book-lifecycle/before-state.json` under the workspace. An exclusive operation
lock serializes this provider's calls. Foreign or abandoned locks fail rather
than being reclaimed by numeric PID. The file cap is 16 MiB and at most sixteen
retained transitions. Superseded completed history is retired at each new capture under the exclusive lock, retaining latest compensation and every unfinished intent. Malformed, unresolved or oversized state fails before effects.
Complete same-directory temporary images are retained when activation fails.
Files are regular, nonlinked and fd-bound; lifecycle records are not published
in the neutral result or Manager status.

Selection uses the admitted root manifest, exact ordered Exec tuple, Node
executable bytes and workspace/configuration paths. Root equality is not a
rollback discriminator: a dependency-only `(R,R)` replacement with a new Node
binding captures its own before-state. A later replacement captures the actual
current baseline instead of reusing an older same-root record. Repeated exact
requests converge using their applicable retained state; an unrelated unfinished
transition is rejected. Compensation restores captured definition/enablement
and running intent after the public desired binding is restored. Immutable old
Book controllers are never invoked for compensation.

Pre may execute the staged controller under the old Node runtime while the
declared final destination does not yet exist. It persists the actual original
Exec snapshot plus a data-only target plan: public payload manifest/inventory
identity, final root, workspace/configuration and Book launch grammar. It marks
the final runtime pending and supplies no guessed future Node tuple or readiness.
Post re-admits the actual destination bytes and its actual interpreter, and saves
the complete final binding before task effects. Stage, final and renamed rollback
controller paths are never operation identifiers. A retained predecessor supplies
inverse intent only when its exact original full binding matches actual post
admission and its completed terminal observation matched the new pre baseline.
An already admitted partial post cannot be replaced by another runtime tuple.
Required restoration bytes must exist; a retained plan cannot authorize executing
an absent or changed root. The Node executable is rehashed before registration
and again before an explicit launch.

For Windows, only the pinned public background-service-runtime Task Scheduler
port controls an admitted current-user, least-privilege exact task. Registration
suppresses registration triggers; starting is a separate operation. A gate is
disabled before stopping exact captured task instances. Task emptiness is
insufficient: the captured current incarnation must actually be absent or
replaced by a different incarnation, and no new live record obstacle may remain.
Definition or process-query uncertainty fails. No lifecycle path kills a numeric
PID or rewrites a daemon nonce/heartbeat/catalog to manufacture ownership.

Legacy 0.4.4 has no recorded original process-start identity. A live incarnation
at its record PID is only a conservative obstacle. Task0 plus such an obstacle
fails without gate/task mutation. A proven task-owned drain may stop the exact
admitted foreground launcher tree and then require actual prior process absence.
Legacy readiness after controlled restoration additionally requires a new nonce,
timestamps after the owned activation-window origin, a fresh running phase, agreeing lock/heartbeat/catalog PID,
actual OS birth and original Node executable, and unchanged task definition and
instance. These observations never retroactively authorize shutdown of a prior
unowned process. A genuine Task0/live orphan remains unsupported under this boundary. Earlier installed Task0 observations used SDK1.3.0/1.3.1 hidden enumeration; the reviewed SDK1.3.2 public observation found a running exact Task instance. This source candidate makes no installed teardown or replacement claim.

An acknowledged Run may still be queued. Within this owned activation attempt,
bounded reinspection must observe a real nonempty GUID set on the same definition,
action and enablement before activity can become ready. Persistent Task0 fails;
there is one Run, no fabricated GUID or timeout-based readiness. The activation
window begins after positive quiescence and before registration/enablement, because
an enabled missed-logon trigger can start before the later Run acknowledgement.
An uncertain previous invocation does not supply a guessed window: its unknown
legacy activity is drained and freshly restarted before proof is attempted.

Portable convergence tests are controller-policy evidence. Owned UUID task tests
exercise actual Windows Scheduler, daemon observation and teardown in isolated
workspaces with acquisition and analysis disabled. Existing signed SDK binaries
are reused unchanged for local source qualification; this does not repurpose an
old signed native receipt as evidence for a new release source. Official 0.4.9
publication requires exact reviewed source, fresh workflow evidence, inventory
and signing. No service installation or live legacy replacement is claimed here.
The immutable044/mixed-runtime fixture is separately gated by explicit public
component and Node24 locators; a runner without those retained payloads reports
an explicit fixture skip. Local qualification supplies both, verifies the public
inventory and actual Node24 version, then proves24-pre/26-post/24-inverse for both
different-root and same-root transactions, including an absent final destination
and renamed rollback controller. It reads no installed provider data.
