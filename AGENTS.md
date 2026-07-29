# AGENTS.md

Book Forge is a spec-driven standalone UCI Arena service.

Before substantive planning, inspection, implementation, or validation run:

```text
node tools/spec-preflight.mjs --task "<description>" --changed-files <paths>
```

Read every returned specification. Public behavior changes update the governing
specification first.

Never read, print, hash, copy, validate, or package credential contents. A
Lichess credential may cross a boundary only as a file path.

Service source may depend only on declared packages and explicit runtime
components. It must never import UCI Arena, Evidence Service, or another source
checkout. Code changes must be tested, committed, pushed, and opened as a draft
pull request.
