#!/usr/bin/env python3
"""Wrap proposal JSON arrays into a second-chair payload the userscript imports.

  build_payload.py --repo octo-org/example --pr 214 --round 1 --head <sha> a.json b.json > payload.json

--mode review marks a payload whose items are the comments of a pending review (Post, Revise, Drop).

Items keep the order of the files; an item whose thread_id starts with GLOBAL goes first.
"""
import argparse
import json
import sys

REQUIRED = {1: ("thread_id", "verdict", "reply_en"), 2: ("thread_id", "reply_en")}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--pr", type=int, required=True)
    ap.add_argument("--round", type=int, choices=(1, 2), required=True)
    ap.add_argument("--head", required=True)
    ap.add_argument("--mode", choices=("reply", "review"), default="reply")
    ap.add_argument("files", nargs="+")
    a = ap.parse_args()
    items = []
    for f in a.files:
        with open(f, encoding="utf-8") as fh:
            items.extend(json.load(fh))
    ids = [i["thread_id"] for i in items]
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        sys.exit(f"duplicate thread_id: {sorted(dupes)}")
    for i in items:
        missing = [k for k in REQUIRED[a.round] if k not in i]
        if missing:
            sys.exit(f"{i.get('thread_id')}: missing {missing}")
    items.sort(key=lambda i: 0 if str(i["thread_id"]).startswith("GLOBAL") else 1)
    payload = {"tool": "second-chair", "kind": "proposals", "repo": a.repo, "pr": a.pr,
               "round": a.round, "head": a.head, "items": items}
    if a.mode != "reply":
        payload["mode"] = a.mode
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
