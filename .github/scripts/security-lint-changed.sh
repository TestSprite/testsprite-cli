#!/usr/bin/env bash
#
# Run the security ESLint pass over a list of changed files and fail only on
# error findings that land on lines the BASE..HEAD diff added or modified.
#
# This is the single definition of the "ESLint Security (changed files)"
# verdict. security.yml calls it for every PR and push, and the release
# pipeline calls it on the publish snapshot's whole delta against live public
# main BEFORE pushing — a release lands on public main as one commit whose
# large diff can re-attribute moved-but-unchanged legacy lines as added, so a
# finding no individual PR ever touched can surface there for the first time.
# Keeping both callers on this one script is what makes the pre-push run a
# faithful preview of the post-push check.
#
# Usage: security-lint-changed.sh <files.nul> <base> <head>
#   files.nul  NUL-separated file list (`git diff -z` / `git ls-files -z`)
#   base       commit the diff is taken from; '' keeps every finding (the
#              full-tree fallback, so nothing new is ever hidden)
#   head       commit whose tree is checked out in the current directory
#
# Exit: 0 = no error finding on a changed line (or nothing to lint),
#       1 = at least one such finding, >1 = ESLint itself crashed.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <files.nul> <base> <head>" >&2
  exit 2
fi
FILE_LIST="$1"
BASE="$2"
HEAD_COMMIT="$3"
REPORT="${FILE_LIST}.eslint-report.json"

# The file list is NUL-separated end-to-end: git diff/ls-files -z -> file ->
# this read loop. Git filenames may contain a literal newline (or start with
# `-`), so splitting on newlines lets a filename like
# "src/x.ts\n--no-error-on-unmatched-pattern\nnot-a-real-file.ts" split into a
# real path, an injected ESLint OPTION, and a nonexistent path — ESLint then
# exits 0 having never linted the malicious file. NUL is the one byte git
# filenames cannot contain, so it is the only safe delimiter here. The
# trailing `--` below additionally stops ESLint's own option parser at the
# file-list boundary, so no filename starting with `-` can be misread as a
# flag. (`read -d ''` rather than `mapfile -d ''` keeps this runnable under
# the bash 3.2 that macOS ships, for operators running it by hand.)
FILES=()
while IFS= read -r -d '' f; do
  FILES+=("$f")
done < "$FILE_LIST"

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "Zero files to lint — a genuine empty result, not a skip."
  exit 0
fi
echo "Linting ${#FILES[@]} file(s)."

# Report raw findings so count-based suppressions cannot hide a new issue;
# the changed-line filter below ignores untouched legacy code.
#
# ESLint exits 1 when it reports findings and 2 on a fatal (config/crash)
# error; only 2 is a real failure here, because the changed-line filter
# below — not ESLint's own exit — decides pass/fail. Capture the report even
# on exit 1, but surface a genuine crash.
set +e
npx eslint --config eslint.security.config.mjs \
  --format json -- "${FILES[@]}" \
  > "$REPORT"
ESLINT_EXIT=$?
set -e
if [ "$ESLINT_EXIT" -gt 1 ]; then
  echo "::error title=Security lint crashed::ESLint exited ${ESLINT_EXIT} (fatal error, not a lint finding)."
  cat "$REPORT" || true
  exit "$ESLINT_EXIT"
fi

# Fail only on findings that land on lines this change added/modified (see
# .github/scripts/filter-changed-line-findings.mjs).
RESOLVED_BASE="$BASE" HEAD_SHA="$HEAD_COMMIT" \
  node .github/scripts/filter-changed-line-findings.mjs "$REPORT"
