#!/bin/sh
# Emit the generated Dockerfile: the committed Dockerfile.template with the
# manifest-splitting COPY blocks filled in at their anchors, plus the R6.6
# per-service default-toggle ENV lines for the current MICROSERVICES selector.
#
# Dependency-free POSIX sh + awk on purpose: CI (and a fresh clone) can produce
# the Dockerfile without installing Node or running npm ci first.
#
# It fills three things into Dockerfile.template:
#   * the # --- MANIFEST_COPY_BUILD --- anchor, with per-workspace package.json
#     COPY lines (build stage);
#   * the # --- MANIFEST_COPY_PRODDEPS --- anchor, with the SAME COPY lines
#     (prod-deps stage);
#   * the per-microservice ENV MICROSERVICE_<X>_ENABLED=enabled toggle defaults,
#     injected before the last ENTRYPOINT.
#
# Shape (O9): a thin shell part that only expands globs and tests file existence,
# handing raw strings to a SINGLE awk invocation through the environment. All
# text processing — selector resolution, exclusion filtering, block
# construction, anchor injection, validation, and header emission — lives in
# that one awk pass. No grep/sed/tr; exactly one external process (awk).
#
# The manifest COPY lines are discovered from the filesystem via glob-style
# listing of exactly four patterns (R11.1) — packages/*/package.json,
# packages/microservices/*/package.json, packages/common/*/package.json and
# packages/spa/*/package.json — so adding a top-level package, a microservice, a
# Common_Package or a Spa_Package requires no change to this file (R11.10).
# Test-only workspaces (integration-tests) and the three Namespace_Container
# directories (microservices, common, spa) are excluded from the TOP-LEVEL scan
# by name (in awk). The exclusion is top-level only: a container member that
# happens to be named `common` or `integration-tests` still gets its COPY line
# (R11.3).
#
# KNOWN, REQUIREMENT-SANCTIONED DUPLICATION — cross-reference:
# packages/build-tools/src/framework.ts is the single declaration site for the
# Namespace_Container directories and the framework package names. This script
# restates `packages/microservices`, `packages/common`, `packages/spa` and the
# four top-level exclusion names as shell/awk literals because it cannot import
# that module: it must run on a freshly cloned repository before anything is
# installed or compiled (R11.7). R10.5 scopes the single-declaration convention
# to `packages/build-tools/src/`, deliberately leaving this script outside it.
# When a Namespace_Container directory or an exclusion name changes in
# framework.ts, this script must be updated in the same change.
#
# Selector handling is deliberately minimal (resolved in awk):
#   *, empty, or whitespace-only -> every directory under packages/microservices
#   otherwise                    -> the comma-separated entries, whitespace trimmed
#
# It does NOT validate that the resulting identifiers exist, and it does NOT
# handle exotic selector spellings (`,,,`, duplicates, ...). That is not a gap:
# `generate-registry` running INSIDE the container is the authority on selector
# validity and fails the build with `[selector:unmatched]` for a bogus
# identifier. This script only decides which toggle defaults to bake in; a
# selector this script mis-reads can at worst bake a harmless extra ENV line
# into a build that the container-side generator then rejects anyway.
#
# Usage: MICROSERVICES=microservice1,microservice2 sh scripts/emit-effective-dockerfile.sh

set -eu

# Byte-value collation (R11.6): pathname expansion sorts its matches according to
# the current collating sequence, so the ambient locale would otherwise decide
# the order of the discovered directory names. LC_ALL=C pins it to ascending byte
# order, which is what the generated block's ordering rule requires and what
# makes two runs on an unchanged tree byte-identical on any machine.
LC_ALL=C
export LC_ALL

DOCKERFILE="${DOCKERFILE:-Dockerfile.template}"
EFFECTIVE="${EFFECTIVE_DOCKERFILE:-Dockerfile}"
NAMESPACE="${MICROSERVICE_NAMESPACE:-packages/microservices}"

# The RAW selector, forwarded to awk verbatim. The shell does NOT trim, split,
# or interpret it — selector resolution lives entirely in awk.
SELECTOR="${MICROSERVICES:-*}"

# Fail fast: the template must exist (there is nothing for awk to read
# otherwise).
if [ ! -f "$DOCKERFILE" ]; then
  echo "[emit-effective-dockerfile] no such Dockerfile template: $DOCKERFILE" >&2
  exit 1
fi

# Fail fast on a missing namespace directory, but ONLY when the selector needs
# to list it (the *, empty, or whitespace-only case). An explicit identifier
# list never consults the namespace, so a missing directory is not fatal for it.
# This decision needs a leading/trailing-whitespace trim of the raw selector;
# the trim is confined to this check and does not resolve the selector (awk
# does that).
sel_probe=$SELECTOR
while :; do
  case $sel_probe in
    [[:space:]]*) sel_probe=${sel_probe#?} ;;
    *) break ;;
  esac
done
while :; do
  case $sel_probe in
    *[[:space:]]) sel_probe=${sel_probe%?} ;;
    *) break ;;
  esac
done
if [ -z "$sel_probe" ] || [ "$sel_probe" = "*" ]; then
  if [ ! -d "$NAMESPACE" ]; then
    echo "[emit-effective-dockerfile] no such Microservice_Namespace: $NAMESPACE" >&2
    exit 1
  fi
fi

# Discover workspace directories via glob-style listing and per-directory
# package.json existence tests — the two things POSIX sh does well and POSIX awk
# cannot do without spawning helpers. Build four COMMA-separated basename lists,
# one per discovery pattern (R11.1):
#   PKG_DIRS    - every packages/*/ that has a package.json (UNFILTERED; the
#                 four top-level exclusions happen in awk).
#   MS_DIRS     - every packages/microservices/*/ that has a package.json.
#   COMMON_DIRS - every packages/common/*/ that has a package.json.
#   SPA_DIRS    - every packages/spa/*/ that has a package.json.
# A glob that matches nothing stays literal, and the `-f` test then drops it, so
# an absent or empty Namespace_Container contributes no entry and the run still
# succeeds (R11.5).
#
# The basename is taken with pure parameter expansion rather than `basename`:
# `${dir%/}` drops the glob's trailing slash, `${name##*/}` the leading path.
# No subshell, no external process per directory (R11.7).
PKG_DIRS=""
for dir in packages/*/; do
  [ -f "$dir/package.json" ] || continue
  name=${dir%/}
  name=${name##*/}
  PKG_DIRS="${PKG_DIRS:+$PKG_DIRS,}$name"
done

MS_DIRS=""
for dir in packages/microservices/*/; do
  [ -f "$dir/package.json" ] || continue
  name=${dir%/}
  name=${name##*/}
  MS_DIRS="${MS_DIRS:+$MS_DIRS,}$name"
done

COMMON_DIRS=""
for dir in packages/common/*/; do
  [ -f "$dir/package.json" ] || continue
  name=${dir%/}
  name=${name##*/}
  COMMON_DIRS="${COMMON_DIRS:+$COMMON_DIRS,}$name"
done

SPA_DIRS=""
for dir in packages/spa/*/; do
  [ -f "$dir/package.json" ] || continue
  name=${dir%/}
  name=${name##*/}
  SPA_DIRS="${SPA_DIRS:+$SPA_DIRS,}$name"
done

export SELECTOR PKG_DIRS MS_DIRS COMMON_DIRS SPA_DIRS DOCKERFILE NAMESPACE

# One awk invocation does everything: read the raw selector + directory lists
# from the environment, resolve the selector, build the manifest and ENV blocks,
# buffer the template, validate in END, and emit the whole document (headers
# first, anchors replaced, ENV block before the last ENTRYPOINT). Nothing is
# printed until validation passes, so a failed run produces no stdout — the
# shell then leaves the temp file empty and never clobbers $EFFECTIVE.
tmp_out=$(mktemp "${TMPDIR:-/tmp}/emit-effective-dockerfile.XXXXXX")

if awk -f - "$DOCKERFILE" <<'AWK' >"$tmp_out"
BEGIN {
  df  = ENVIRON["DOCKERFILE"]
  raw = ENVIRON["SELECTOR"]

  n_pkg    = split(ENVIRON["PKG_DIRS"], pkg, ",")
  n_ms     = split(ENVIRON["MS_DIRS"], ms, ",")
  n_common = split(ENVIRON["COMMON_DIRS"], common, ",")
  n_spa    = split(ENVIRON["SPA_DIRS"], spa, ",")

  # Resolve the selector, mirroring resolveSelected()/parseSelector() exactly.
  # Trim leading/trailing whitespace with POSIX ERE; if the trimmed result is
  # "*", the list is every microservice in listed order. Otherwise split the RAW
  # selector on ",", trim each entry, and drop empties; if that leaves ZERO
  # entries (blank, whitespace-only, or a comma-only spelling such as ",,,"),
  # fall back to all microservices too — matching parseSelector()'s
  # `identifiers.length === 0 ? {kind:"all"}` branch. Only a non-empty entry
  # list stays a list.
  s = raw
  gsub(/^[[:space:]]+|[[:space:]]+$/, "", s)
  id_count = 0
  if (s != "*") {
    n_sel = split(raw, sel, ",")
    for (i = 1; i <= n_sel; i++) {
      e = sel[i]
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", e)
      if (e != "") { id_count++; ids[id_count] = e }
    }
  }
  if (id_count == 0) {
    for (i = 1; i <= n_ms; i++) {
      if (ms[i] != "") { id_count++; ids[id_count] = ms[i] }
    }
  }

  # Manifest COPY block (R11.2, R11.6): header, root manifests, one COPY per
  # non-excluded top-level package, then one group per Namespace_Container in the
  # fixed order microservices, common, spa. Every group keeps the listed order,
  # which is the byte order LC_ALL=C glob expansion produced.
  #
  # The four-entry exclusion list — integration-tests (test-only) plus the three
  # Namespace_Container directories — is applied ONLY to the top-level pkg[] loop
  # (R11.3), so a container member named `common` or `integration-tests` still
  # gets its COPY line.
  manifest = "# --- manifest COPY (generated by scripts/emit-effective-dockerfile.sh) ---"
  manifest = manifest "\n" "COPY package.json package-lock.json ./"
  for (i = 1; i <= n_pkg; i++) {
    name = pkg[i]
    if (name == "" || name == "integration-tests" || name == "microservices" \
        || name == "common" || name == "spa") continue
    manifest = manifest "\n" "COPY packages/" name "/package.json packages/" name "/"
  }
  for (i = 1; i <= n_ms; i++) {
    name = ms[i]
    if (name == "") continue
    manifest = manifest "\n" "COPY packages/microservices/" name "/package.json packages/microservices/" name "/"
  }
  for (i = 1; i <= n_common; i++) {
    name = common[i]
    if (name == "") continue
    manifest = manifest "\n" "COPY packages/common/" name "/package.json packages/common/" name "/"
  }
  for (i = 1; i <= n_spa; i++) {
    name = spa[i]
    if (name == "") continue
    manifest = manifest "\n" "COPY packages/spa/" name "/package.json packages/spa/" name "/"
  }

  # ENV toggle-default block: header naming the RAW selector, then one ENV line
  # per resolved identifier, uppercased.
  env_block = "# --- R6.6 toggle defaults (generated by scripts/emit-effective-dockerfile.sh; selector: " raw ") ---"
  for (i = 1; i <= id_count; i++) {
    env_block = env_block "\n" "ENV MICROSERVICE_" toupper(ids[i]) "_ENABLED=enabled"
  }

  header1 = "# AUTO-GENERATED from Dockerfile.template by scripts/emit-effective-dockerfile.sh. Do not edit."
  header2 = "# Selector: " raw
}

{ line[NR] = $0 }
$0 ~ /^[[:space:]]*# --- MANIFEST_COPY_BUILD ---[[:space:]]*$/    { build_anchor = NR }
$0 ~ /^[[:space:]]*# --- MANIFEST_COPY_PRODDEPS ---[[:space:]]*$/ { prod_anchor  = NR }
$0 ~ /^[[:space:]]*ENTRYPOINT([[:space:]]|\[)/                    { last_entry  = NR }

END {
  # Validate before ANY output (mirrors the current script's order:
  # ENTRYPOINT, then the two manifest anchors, then selector resolution). Each
  # failure writes the exact legacy message and exits non-zero with no stdout.
  if (!last_entry) {
    print "[emit-effective-dockerfile] " df " has no ENTRYPOINT instruction to anchor the toggle-default ENV injection" > "/dev/stderr"
    exit 1
  }
  if (!build_anchor) {
    print "[emit-effective-dockerfile] " df " is missing the '# --- MANIFEST_COPY_BUILD ---' anchor" > "/dev/stderr"
    exit 1
  }
  if (!prod_anchor) {
    print "[emit-effective-dockerfile] " df " is missing the '# --- MANIFEST_COPY_PRODDEPS ---' anchor" > "/dev/stderr"
    exit 1
  }
  if (id_count == 0) {
    print "[emit-effective-dockerfile] selector '" raw "' resolved to no microservices" > "/dev/stderr"
    exit 1
  }

  print header1
  print header2
  for (i = 1; i <= NR; i++) {
    if (i == build_anchor || i == prod_anchor) { print manifest; continue }
    if (i == last_entry)                        { print env_block }
    print line[i]
  }
}
AWK
then
  mv "$tmp_out" "$EFFECTIVE"
  echo "[emit-effective-dockerfile] wrote $EFFECTIVE for selector '$SELECTOR'"
else
  status=$?
  rm -f "$tmp_out"
  exit "$status"
fi
