# B2 clean-room attempt — STOPPED

Date: 2026-10-31

Scope: approved headless local path only; no hosted inference. Same machine with isolated Git/npm configs and sanitized child environment, not an OS/network sandbox.

Clone, public tag fetch and base checkout succeeded (exit 0). HEAD is f9525055c56a7f7771dd2fa029c147c2960a98a3. Status was clean before script execution.

Reviewed apply script hash: 8CB2F8031ADDF939209005B094EC412DE21203414C8F36DC12936CD506693044.

Script applies each overlay THEN verifies it (lines 116-122). Overlay 0001 was applied successfully, then verification exited 1. Overlays 0002 and 0003 were not applied. The disposable checkout is left partially applied, with 93 porcelain status entries and unchanged/empty real index (exit 0). No reset or cleanup was performed.

Cause: relative .git/index returned by git rev-parse --git-path index is compared directly with absolute C:/clean/core/.git/index. There was no inherited GIT_INDEX_FILE/GIT_DIR/GIT_WORK_TREE override in the runner environment.

Read-only diagnostic: git rev-parse --path-format=absolute --git-path index returns C:/clean/core/.git/index, the intended index. Normalize the relative path or request absolute formatting before comparison; test both ordinary clones and linked worktrees, retaining all environment/staged-index guards.

No npm installs, backend builds, Rust builds, engine execution, demo runs, source fixes, commits or pushes. Main source, event staging and frozen FIX-16 packet were not edited. B2 remains unverified.

Retained checkout: C:/clean/core (partially applied). Isolated profile: C:/clean/maos-b2-profile-2026-10-31. Runner and full command/stdout/stderr/exit evidence retained in this directory.
