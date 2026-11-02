#!/usr/bin/env python3
"""Classify a Dependabot pull request for .github/workflows/dependabot-automerge.yml.

Dependabot does not apply `semver:*` labels itself, so the bump size is derived
from the versions the PR names: the title ("bump x from 5.9.1 to 6.0.2") and the
"Updates `x` from 1.60.0 to 1.63.0" lines of grouped PRs. Version pairs that
cannot be compared are treated as major, so an unrecognized bump is held for a
human instead of being merged.

Reads `gh pr list --json ...` output on stdin and prints exactly one of:

  pr=<number>     approve and merge
  major=<number>  leave for manual review
  stale=<number>  a newer push exists; its own review run decides
  (nothing)       no eligible pull request
"""

import json
import os
import re
import sys

AUTHORS = ("dependabot[bot]", "app/dependabot")
PAIR = re.compile(r"from\s+`?(v?\d[\w.+-]*)`?\s+to\s+`?(v?\d[\w.+-]*)`?")
BODY_PAIR = re.compile(
    r"^Updates `[^`]+` from\s+`?(v?\d[\w.+-]*)`?\s+to\s+`?(v?\d[\w.+-]*)`?",
    re.MULTILINE,
)
GROUP_TITLE = re.compile(r"\bbump the .+ group\b")


def is_major(pr: dict) -> bool:
    pairs = PAIR.findall(pr["title"])
    if not pairs:
        pairs = BODY_PAIR.findall(pr.get("body") or "")
    if not pairs:
        # Groups are configured for minor and patch updates only; a bump we
        # cannot read outside a group is held rather than merged blind.
        return not GROUP_TITLE.search(pr["title"])
    for old, new in pairs:
        try:
            if int(old.lstrip("v").split(".")[0]) != int(new.lstrip("v").split(".")[0]):
                return True
        except ValueError:
            return True
    return False


def main() -> None:
    prs = json.load(sys.stdin)
    candidates = [
        pr
        for pr in prs
        if pr["author"]["login"] in AUTHORS and pr["baseRefName"] == "main"
    ]
    if len(candidates) != 1:
        return
    pr = candidates[0]
    if pr["headRefOid"] != os.environ["HEAD_SHA"]:
        print(f"stale={pr['number']}")
    elif "semver:major" in {label["name"] for label in pr.get("labels", [])} or is_major(pr):
        print(f"major={pr['number']}")
    else:
        print(f"pr={pr['number']}")


if __name__ == "__main__":
    main()
