#!/bin/sh
# Emit the generated Dockerfile: the committed Dockerfile.template with the
# manifest-splitting COPY blocks filled in at their anchors, plus the R6.6
# per-service default-toggle ENV lines for the current MICROSERVICES selector.
#
# Dependency-free POSIX sh + awk on purpose: CI (and a fresh clone) can produce
# the Dockerfile without installing Node or running npm ci first (R11.1). It
# invokes only the external commands the Pre_Change_Baseline invoked — `awk`
# (now in two passes rather than one; see below), plus `mktemp` and `mv` for the
# atomic write — imports no compiled Build_System module, and requires no
# installed dependency directory, no completed install, and no completed
# compile.
#
# It fills four things into Dockerfile.template:
#   * the # --- MANIFEST_COPY_BUILD --- anchor, with per-workspace package.json
#     COPY lines (build stage);
#   * the # --- MANIFEST_COPY_PRODDEPS --- anchor, with the SAME COPY lines
#     (prod-deps stage);
#   * the per-microservice ENV MICROSERVICE_<X>_ENABLED=enabled toggle defaults,
#     injected before the last ENTRYPOINT;
#   * the # --- CMD --- anchor, with the single CMD instruction naming the
#     Entry_Point_Path (R7.3).
#
# CONFIG-DRIVEN DISCOVERY (R11.1, R11.3, R11.4, R11.5). The three Discovery_Roots
# — microservice, common, spa — are no longer fixed literals. They are read from
# the Project_Config_File (scaffold.config.json) directly inside the
# Project_Directory, and each defaults to its Root_Default when the file is
# absent or declares no `roots` member. The Manifest_Copy_Block iterates the
# CONFIGURED roots, and the top-level Exclusion_List is DERIVED as the first path
# segment of each configured root plus the by-name test-only `integration-tests`.
#
# THE ENTRY_ROOT (R7.3, R7.4, R7.5, R7.6). The `entry` key is read from the same
# Project_Config_File, the same way and with the same discipline as the three
# roots — the character sequence delimited by the surrounding double quotes, no
# trimming, no normalisation, checked against the same Valid_Root_Path predicate
# — and defaults to the Entry_Root_Default `app` when the key or the file is
# absent. It contributes exactly one manifest COPY line (the Entry_Package's
# package.json, appended last) and the single CMD instruction, whose
# Entry_Point_Path is the Entry_Root joined to `dist/index.js` by one `/`. The
# Exclusion_List derivation is untouched: the Entry_Root is not a
# `packages/<name>` path, so no top-level entry gains or loses an exclusion.
#
# The scope is NOT read here (R11.12): this script reads the three roots and no
# other value. The Configured_Scope reaches the container build as the
# `ARG WORKSPACE_SCOPE` build argument declared in Dockerfile.template.
#
# Shape (O9): the config read is one `awk` pass (pass 1) that prints three
# already-defaulted KEY=value lines; the shell reads them back with builtins
# only (no eval), then expands the directory-listing globs under the roots pass
# 1 reported; a second `awk` pass (pass 2) does all remaining text processing —
# selector resolution, exclusion filtering, block construction, anchor
# injection, validation, and header emission. No grep/sed/tr/jq/node; the only
# external command is `awk`, invoked twice.
#
# The manifest COPY lines are discovered from the filesystem via glob-style
# listing under the configured roots plus packages/*/package.json for the
# top-level scan (R11.4), so adding a top-level package, a microservice, a
# Common_Package or a Spa_Package requires no change to this file (R11.10).
# Test-only workspaces (integration-tests) and the first path segment of each
# configured Discovery_Root are excluded from the TOP-LEVEL scan by the derived
# Exclusion_List (in awk). The exclusion is top-level only: a container member
# that happens to be named after an exclusion entry still gets its COPY line
# (R11.3).
#
# KNOWN, REQUIREMENT-SANCTIONED DUPLICATION — cross-reference:
# packages/build-tools/src/project-config.ts is the single declaration site for
# the three Root_Defaults (packages/microservices, packages/common,
# packages/spa), the Entry_Root_Default (app) and the Scope_Default. This script
# restates the three Root_Defaults and the Entry_Root_Default as awk literals
# (pass 1) because it cannot import that module: it
# must run on a freshly cloned repository before anything is installed or
# compiled (R11.1). R1.8's single-declaration rule, R7.1's single-derivation rule
# and R10.5's single-declaration
# convention are all scoped to packages/build-tools/src/, deliberately leaving
# this script outside them. When a Root_Default or the Entry_Root_Default changes
# in project-config.ts,
# this script must be updated in the same change. The Scope_Default is NOT among
# the duplicated literals: this script no longer restates it — the only place
# outside project-config.ts that carries it is the ARG WORKSPACE_SCOPE default in
# Dockerfile.template.
#
# Selector handling is deliberately minimal (resolved in awk):
#   *, empty, or whitespace-only -> every direct subdirectory of the configured
#                                   microservice Discovery_Root
#   otherwise                    -> the comma-separated entries, whitespace trimmed
#
# It does NOT validate that the resulting identifiers exist, and it does NOT
# handle exotic selector spellings (`,,,`, duplicates, ...) beyond the comma-only
# fallback. That is not a gap: `generate-registry` running INSIDE the container
# is the authority on selector validity and fails the build with
# `[selector:unmatched]` for a bogus identifier. This script only decides which
# toggle defaults to bake in.
#
# Usage: MICROSERVICES=microservice1,microservice2 sh scripts/emit-effective-dockerfile.sh

set -eu

# Byte-value collation (R11.11): pathname expansion sorts its matches according
# to the current collating sequence, so the ambient locale would otherwise
# decide the order of the discovered directory names. LC_ALL=C pins it to
# ascending byte order, which is what the generated block's ordering rule
# requires and what makes two runs on an unchanged tree byte-identical on any
# machine.
LC_ALL=C
export LC_ALL

DOCKERFILE="${DOCKERFILE:-Dockerfile.template}"
EFFECTIVE="${EFFECTIVE_DOCKERFILE:-Dockerfile}"
PROJECT_CONFIG_FILE="${PROJECT_CONFIG_FILE:-scaffold.config.json}"
export PROJECT_CONFIG_FILE

# The RAW selector, forwarded to awk verbatim. The shell does NOT trim, split,
# or interpret it — selector resolution lives entirely in awk.
SELECTOR="${MICROSERVICES:-*}"

# Fail fast: the template must exist (there is nothing for awk to read
# otherwise).
if [ ! -f "$DOCKERFILE" ]; then
  echo "[emit-effective-dockerfile] no such Dockerfile template: $DOCKERFILE" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Pass 1: read the three Discovery_Roots and the Entry_Root from the
# Project_Config_File.
#
# Prints exactly four lines (MS_ROOT=, COMMON_ROOT=, SPA_ROOT=, ENTRY_ROOT=), each
# already
# defaulted. An absent file is not an error (R11.2, R7.4): getline returns -1 and
# every
# value keeps its default. On a value it cannot read as a one-line unescaped
# JSON string it writes the R11.7 message to stderr and exits 1; `set -e` then
# aborts this command substitution before the temp file for pass 2 is ever
# created, so nothing is written to the generated Dockerfile path.
# ---------------------------------------------------------------------------
config_lines=$(awk -f - </dev/null <<'AWK'
BEGIN {
  cfg = ENVIRON["PROJECT_CONFIG_FILE"]

  # The three Root_Defaults, restated here as awk literals. See the
  # cross-reference note above: this script cannot import project-config.ts.
  root["microservice"] = "packages/microservices"
  root["common"]       = "packages/common"
  root["spa"]          = "packages/spa"

  # The Entry_Root_Default, restated here for the same reason (R7.4). An absent
  # file, or a file declaring no `entry` key, leaves this default in place.
  entry_root = "app"

  depth = 0; in_roots = 0
  while ((getline line < cfg) > 0) scan(line)
  close(cfg)

  print "MS_ROOT=" root["microservice"]
  print "COMMON_ROOT=" root["common"]
  print "SPA_ROOT=" root["spa"]
  print "ENTRY_ROOT=" entry_root
}

# One line, character by character. Tracks object depth, remembers the key seen
# at depth 1 and at depth 2 inside `roots`, and reads a value only when it is a
# `"`-delimited run on this same line — which is exactly the extraction rule
# R11.1 states.
function scan(s,   i, c, n, key) {
  n = length(s); i = 1
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\"") {
      readString(s, i)                    # sets G_str, G_next; G_next < 0 on failure
      if (G_next < 0) fail("unterminated or escaped string")
      i = G_next
      # A string is a key when the next non-blank character is ":".
      if (nextNonBlank(s, i) == ":") {
        key = G_str
        i = skipTo(s, i, ":") + 1
        assign(key, s, i)                 # may consume this line's value
      }
      continue
    }
    if (c == "{") { depth++; i++; continue }
    if (c == "}") { if (in_roots && depth == 2) in_roots = 0; depth--; i++; continue }
    i++
  }
}

# Records a recognised key's value, or enters/leaves the `roots` object.
function assign(key, s, i,   c, j) {
  c = nextNonBlank(s, i)
  if (depth == 1 && key == "roots") {
    if (c != "{") fail("roots")           # not an object -> R11.7
    in_roots = 1; return
  }
  # The Entry_Root (R7.4): a depth-1 key read with exactly the discipline the
  # three roots get — a one-line `"`-delimited run, no trimming, no
  # normalisation, checked against the same Valid_Root_Path predicate. Anything
  # else is unreadable and calls fail("entry") (R7.5).
  if (depth == 1 && !in_roots && key == "entry") {
    if (c != "\"") fail("entry")                  # not a one-line quoted string
    j = indexOfNonBlank(s, i)
    readString(s, j); if (G_next < 0) fail("entry")
    if (!validRoot(G_str)) fail("entry")          # Valid_Root_Path set (R4.3)
    entry_root = G_str; return                    # a later duplicate wins, as JSON.parse does
  }
  if (in_roots && depth == 2 && (key == "microservice" || key == "common" || key == "spa")) {
    if (c != "\"") fail("roots." key)             # not a one-line quoted string
    j = indexOfNonBlank(s, i)
    readString(s, j); if (G_next < 0) fail("roots." key)
    if (!validRoot(G_str)) fail("roots." key)     # Valid_Root_Path set (R4.3)
    root[key] = G_str; return                     # a later duplicate wins, as JSON.parse does
  }
  # Every other key is skipped: unrecognised, or nested deeper than `roots`.
}

# Read a `"`-delimited string starting at the `"` at position `start`. Sets
# G_str to the delimited run and G_next to the index just past the closing `"`.
# Fails (G_next < 0) if the run reaches end of line with no closing `"`, or if it
# contains a `\` (an escape sequence the one-line extraction rule rejects).
function readString(s, start,   n, i, c) {
  n = length(s)
  G_str = ""
  G_next = -1
  i = start + 1                           # skip the opening quote
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\\") { G_next = -1; return }   # any escape -> unreadable
    if (c == "\"") { G_next = i + 1; return }
    G_str = G_str c
    i++
  }
  G_next = -1                             # reached end of line, unterminated
}

# The first non-blank character at or after position `i` (or "" past end).
function nextNonBlank(s, i,   n, c) {
  n = length(s)
  while (i <= n) {
    c = substr(s, i, 1)
    if (c != " " && c != "\t") return c
    i++
  }
  return ""
}

# The index of the first non-blank character at or after position `i`.
function indexOfNonBlank(s, i,   n, c) {
  n = length(s)
  while (i <= n) {
    c = substr(s, i, 1)
    if (c != " " && c != "\t") return i
    i++
  }
  return i
}

# The index of the first occurrence of `ch` at or after position `i`.
function skipTo(s, i, ch,   n) {
  n = length(s)
  while (i <= n) {
    if (substr(s, i, 1) == ch) return i
    i++
  }
  return n
}

# The Valid_Root_Path character and segment rules (R4.3), restated as ERE tests.
function validRoot(p) {
  if (p == "" || p ~ /^\// || p ~ /\/$/) return 0
  if (p ~ /[\\*?]/ || p ~ /[[:space:]]/) return 0
  if (p ~ /(^|\/)\.\.?(\/|$)/) return 0        # no "." and no ".." segment
  if (p ~ /\/\//) return 0                      # no empty segment
  return 1
}

function fail(key) {
  print "[emit-effective-dockerfile] " ENVIRON["PROJECT_CONFIG_FILE"] \
        ": cannot read the value of \"" key "\" as a single-line unescaped JSON string" \
        > "/dev/stderr"
  exit 1
}
AWK
)

# Read the three lines back with builtins only — no external command, no eval
# (R11.1). A config value never reaches the shell as code; the values were
# already validated against the Valid_Root_Path set in pass 1, so they hold no
# metacharacter, but this shape keeps that from being load-bearing.
MS_ROOT=""; COMMON_ROOT=""; SPA_ROOT=""; ENTRY_ROOT=""
while IFS='=' read -r k v; do
  case $k in
    MS_ROOT) MS_ROOT=$v ;;
    COMMON_ROOT) COMMON_ROOT=$v ;;
    SPA_ROOT) SPA_ROOT=$v ;;
    ENTRY_ROOT) ENTRY_ROOT=$v ;;
  esac
done <<EOF
$config_lines
EOF

# Fail fast on a missing microservice root, but ONLY when the selector needs to
# list it (the *, empty, or whitespace-only case). An explicit identifier list
# never consults the root, so a missing directory is not fatal for it. This
# decision needs a leading/trailing-whitespace trim of the raw selector; the
# trim is confined to this check and does not resolve the selector (awk does
# that). (R11.10)
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
  if [ ! -d "$MS_ROOT" ]; then
    echo "[emit-effective-dockerfile] no such microservice Discovery_Root: $MS_ROOT" >&2
    exit 1
  fi
fi

# Discover workspace directories via glob-style listing and per-directory
# package.json existence tests — the two things POSIX sh does well and POSIX awk
# cannot do without spawning helpers. Build four COMMA-separated basename lists:
#   PKG_DIRS    - every packages/*/ that has a package.json (UNFILTERED; the
#                 derived exclusions happen in awk).
#   MS_DIRS     - every <MS_ROOT>/*/ that has a package.json.
#   COMMON_DIRS - every <COMMON_ROOT>/*/ that has a package.json.
#   SPA_DIRS    - every <SPA_ROOT>/*/ that has a package.json.
# A glob that matches nothing stays literal, and the `-f` test then drops it, so
# an absent or empty Discovery_Root contributes no entry and the run still
# succeeds (R11.9).
#
# The basename is taken with pure parameter expansion rather than `basename`:
# `${dir%/}` drops the glob's trailing slash, `${name##*/}` the leading path.
# No subshell, no external process per directory (R11.1).
PKG_DIRS=""
for dir in packages/*/; do
  [ -f "$dir/package.json" ] || continue
  name=${dir%/}
  name=${name##*/}
  PKG_DIRS="${PKG_DIRS:+$PKG_DIRS,}$name"
done

MS_DIRS=""
for dir in "$MS_ROOT"/*/; do
  [ -f "$dir/package.json" ] || continue
  name=${dir%/}
  name=${name##*/}
  MS_DIRS="${MS_DIRS:+$MS_DIRS,}$name"
done

COMMON_DIRS=""
for dir in "$COMMON_ROOT"/*/; do
  [ -f "$dir/package.json" ] || continue
  name=${dir%/}
  name=${name##*/}
  COMMON_DIRS="${COMMON_DIRS:+$COMMON_DIRS,}$name"
done

SPA_DIRS=""
for dir in "$SPA_ROOT"/*/; do
  [ -f "$dir/package.json" ] || continue
  name=${dir%/}
  name=${name##*/}
  SPA_DIRS="${SPA_DIRS:+$SPA_DIRS,}$name"
done

export SELECTOR PKG_DIRS MS_DIRS COMMON_DIRS SPA_DIRS DOCKERFILE
export MS_ROOT COMMON_ROOT SPA_ROOT ENTRY_ROOT

# ---------------------------------------------------------------------------
# Pass 2: build the whole document from the environment.
#
# Reads the raw selector + directory lists + configured roots from the
# environment, resolves the selector, builds the manifest and ENV blocks,
# buffers the template, validates in END, and emits the whole document (headers
# first, anchors replaced, ENV block before the last ENTRYPOINT). Nothing is
# printed until validation passes, so a failed run produces no stdout — the
# shell then leaves the temp file empty and never clobbers $EFFECTIVE.
# ---------------------------------------------------------------------------
tmp_out=$(mktemp "${TMPDIR:-/tmp}/emit-effective-dockerfile.XXXXXX")

if awk -f - "$DOCKERFILE" <<'AWK' >"$tmp_out"
BEGIN {
  df  = ENVIRON["DOCKERFILE"]
  raw = ENVIRON["SELECTOR"]

  ms_root     = ENVIRON["MS_ROOT"]
  common_root = ENVIRON["COMMON_ROOT"]
  spa_root    = ENVIRON["SPA_ROOT"]
  entry_root  = ENVIRON["ENTRY_ROOT"]

  # The Entry_Point_Path (R7.1's value, composed here for the reason the
  # Root_Defaults are duplicated here): the Entry_Root joined to `dist/index.js`
  # by a single `/`, with no normalisation of either part.
  entry_point = entry_root "/dist/index.js"

  n_pkg    = split(ENVIRON["PKG_DIRS"], pkg, ",")
  n_ms     = split(ENVIRON["MS_DIRS"], ms, ",")
  n_common = split(ENVIRON["COMMON_DIRS"], common, ",")
  n_spa    = split(ENVIRON["SPA_DIRS"], spa, ",")

  # The Exclusion_List (R11.5): a top-level `packages/<name>` entry is excluded
  # exactly when the whole path `packages/<name>` is one of the configured
  # Discovery_Roots — i.e. that root points directly at a top-level package
  # directory, so the container itself must not contribute a COPY line while its
  # members do — together with the single by-name test-only exclusion
  # `integration-tests`.
  #
  # Under the DEFAULT configuration the three roots ARE `packages/microservices`,
  # `packages/common`, `packages/spa`, so the excluded top-level names are
  # exactly `microservices`, `common`, `spa` plus `integration-tests` — the
  # baseline's four names, which keeps R11.2's byte-identical output holding.
  # A root OUTSIDE `packages/` (e.g. `services`) is never equal to any
  # `packages/<name>`, so it excludes nothing under `packages/` and its members
  # ride their own group loop instead. The comparison is one lookup in
  # `configured_root_path[]`, so R11.4's two clauses cannot drift apart.
  excl["integration-tests"] = 1
  configured_root_path[ms_root] = 1
  configured_root_path[common_root] = 1
  configured_root_path[spa_root] = 1

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

  # Manifest COPY block (R11.3, R11.4, R11.11): header, root manifests, one COPY
  # per non-excluded top-level package, then one group per configured
  # Discovery_Root in the fixed order microservice, common, spa. Every group
  # keeps the listed order, which is the byte order LC_ALL=C glob expansion
  # produced.
  #
  # The derived Exclusion_List is applied ONLY to the top-level pkg[] loop
  # (R11.3), so a container member whose name equals an exclusion entry still
  # gets its COPY line. The block is emitted even when it holds zero member
  # COPY lines: the root manifests keep it well-formed (R11.3).
  manifest = "# --- manifest COPY (generated by scripts/emit-effective-dockerfile.sh) ---"
  manifest = manifest "\n" "COPY package.json package-lock.json ./"
  for (i = 1; i <= n_pkg; i++) {
    name = pkg[i]
    if (name == "") continue
    if (name in excl) continue                                  # by-name test-only exclusion
    if (("packages/" name) in configured_root_path) continue    # a configured root points here
    manifest = manifest "\n" "COPY packages/" name "/package.json packages/" name "/"
  }
  for (i = 1; i <= n_ms; i++) {
    name = ms[i]
    if (name == "") continue
    manifest = manifest "\n" "COPY " ms_root "/" name "/package.json " ms_root "/" name "/"
  }
  for (i = 1; i <= n_common; i++) {
    name = common[i]
    if (name == "") continue
    manifest = manifest "\n" "COPY " common_root "/" name "/package.json " common_root "/" name "/"
  }
  for (i = 1; i <= n_spa; i++) {
    name = spa[i]
    if (name == "") continue
    manifest = manifest "\n" "COPY " spa_root "/" name "/package.json " spa_root "/" name "/"
  }
  # The Entry_Package's manifest (R7.4), appended LAST and unconditionally — no
  # `-f` existence test, unlike the four discovered groups. The Entry_Package is
  # one known path rather than a discovered set, and an absent manifest should
  # fail `docker build` at the COPY rather than silently produce an image with no
  # entrypoint. Appending it last keeps every retained COPY line at its existing
  # index inside the block.
  manifest = manifest "\n" "COPY " entry_root "/package.json " entry_root "/"

  # ENV toggle-default block (R11.6): header naming the RAW selector, then one
  # ENV line per resolved identifier, uppercased (ASCII only, via toupper).
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
$0 ~ /^[[:space:]]*# --- CMD ---[[:space:]]*$/                    { cmd_anchor   = NR }
$0 ~ /^[[:space:]]*ENTRYPOINT([[:space:]]|\[)/                    { last_entry  = NR }
# A CMD instruction of the template's own — a comment line such as the anchor
# above never matches, because the instruction must start the line. The FIRST one
# found is the one the failure names (R7.3).
$0 ~ /^[[:space:]]*CMD([[:space:]]|\[)/                           { if (!own_cmd) own_cmd = NR }

END {
  # Validate before ANY output (mirrors the baseline's order: ENTRYPOINT, then
  # the two manifest anchors, then selector resolution). Each failure writes the
  # exact message and exits non-zero with no stdout.
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
  if (!cmd_anchor) {
    print "[emit-effective-dockerfile] " df " is missing the '# --- CMD ---' anchor" > "/dev/stderr"
    exit 1
  }
  # A retained CMD would give the generated file a second one (R7.3), so the
  # template must declare none of its own.
  if (own_cmd) {
    print "[emit-effective-dockerfile] " df " declares its own CMD instruction at line " own_cmd ": " line[own_cmd] > "/dev/stderr"
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
    # The single CMD instruction (R7.3): the anchor line is REPLACED by it, and
    # nothing else is printed there.
    if (i == cmd_anchor) { print "CMD [\"node\", \"" entry_point "\"]"; continue }
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
