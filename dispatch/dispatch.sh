#!/bin/sh
# cf-orbs dispatch program. `amp orb provider` runs it once per job.
#
# Input (env, from Amp): ORB_OPERATION ORB_ID ORB_IMAGE ORB_SNAPSHOT_ID ORB_TOKEN AMP_URL
# Input (env, from cf-orbs):
#   CF_ORBS_URL                 control plane base URL (default http://control.internal)
#   CF_ORBS_CONTROL_TOKEN       bearer for the public /v1 API (external mode only)
#   CF_ORBS_CONTROL_TOKEN_FILE  file that holds the bearer (used when CF_ORBS_CONTROL_TOKEN is unset)
#   CF_ORBS_DEADLINE_SECONDS    give up after this many seconds (default 270)
# Flow: POST /v1/orbs/<orb>/ops, then long-poll GET /v1/ops/<opId>?wait=20 and print new progress lines.
# Exit: 0 ok, 1 failure, 2 bad input.
# Needs only sh, curl, sed, awk, date, sleep. No secret goes on a command line: curl reads its
# config (URL, auth header, body) from stdin. Every printed line goes through redact().
set -u
umask 077
LC_ALL=C
export LC_ALL

NL='
'
CR=$(printf '\r')

# --- awk programs (POSIX awk; tested with gawk and mawk) -------------------------------------

# Redact secrets in each input line. Exact values come from env, never from argv.
# shellcheck disable=SC2016 # awk program, not shell
REDACT_AWK='
function lit(s, v,   i, out) {
  if (length(v) < 4) return s
  out = ""
  while ((i = index(s, v)) > 0) { out = out substr(s, 1, i - 1) "[redacted]"; s = substr(s, i + length(v)) }
  return out s
}
BEGIN {
  t = "[A-Za-z0-9_-]"
  orbre = "orb_" t t t t t t t t t t t t t t t t t "*"
}
{
  s = lit($0, ENVIRON["ORB_TOKEN"])
  s = lit(s, ENVIRON["CFO_CTL"])
  gsub(/aop_live_[A-Za-z0-9_-]+/, "aop_live_[redacted]", s)
  gsub(orbre, "orb_[redacted]", s)
  gsub(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?/, "[redacted-jwt]", s)
  gsub(/[Bb][Ee][Aa][Rr][Ee][Rr][ =:]+[^ ",;]+/, "Bearer [redacted]", s)
  print s
}'

# Build the op request body (OpRequest in worker/src/core/types.ts) from env. Escapes \, ", and
# control characters, so any byte string round-trips. Empty values are omitted.
BODY_AWK='
function q(s,   out, i, n, c) {
  out = ""
  n = length(s)
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    if (c == "\\") out = out "\\\\"
    else if (c == "\"") out = out "\\\""
    else if (c in code) {
      if (c == "\n") out = out "\\n"
      else if (c == "\r") out = out "\\r"
      else if (c == "\t") out = out "\\t"
      else out = out sprintf("\\u%04x", code[c])
    } else out = out c
  }
  return "\"" out "\""
}
function add(key, envname) {
  if (ENVIRON[envname] != "") body = body ",\"" key "\":" q(ENVIRON[envname])
}
BEGIN {
  for (i = 1; i < 32; i++) code[sprintf("%c", i)] = i
  code[sprintf("%c", 127)] = 127
  op = ENVIRON["ORB_OPERATION"]
  body = "{\"op\":" q(op)
  add("snapshotId", "ORB_SNAPSHOT_ID")
  if (op == "spawn") {
    add("image", "ORB_IMAGE")
    add("token", "ORB_TOKEN")
    add("ampUrl", "AMP_URL")
  }
  print body "}"
}'

# Read one JSON object on stdin. Print its top-level scalars as `key=value` and the string
# elements of its top-level arrays as `key[]=value`. Nested objects are skipped. Strings are
# decoded; control characters become spaces so each value stays on one line. Exit 3 if malformed.
# shellcheck disable=SC2016 # awk program, not shell
JSON_AWK='
function hexval(h,   i, v, d) {
  v = 0
  for (i = 1; i <= length(h); i++) {
    d = index("0123456789abcdef", tolower(substr(h, i, 1)))
    if (d == 0) bad()
    v = v * 16 + d - 1
  }
  return v
}
function utf8(cp) {
  if (cp < 32) return " "
  if (cp < 128) return sprintf("%c", cp)
  if (cp < 2048) return sprintf("%c%c", 192 + int(cp / 64), 128 + cp % 64)
  if (cp < 65536) return sprintf("%c%c%c", 224 + int(cp / 4096), 128 + int(cp / 64) % 64, 128 + cp % 64)
  return sprintf("%c%c%c%c", 240 + int(cp / 262144), 128 + int(cp / 4096) % 64, 128 + int(cp / 64) % 64, 128 + cp % 64)
}
function bad() { err = 1; exit 3 }
function ws(   c) {
  while (P <= N) { c = substr(S, P, 1); if (c != " " && c != "\t" && c != "\n" && c != "\r") return; P++ }
}
function str(   out, c, e, cp, lo) {
  if (substr(S, P, 1) != "\"") bad()
  P++
  out = ""
  while (1) {
    if (P > N) bad()
    c = substr(S, P, 1)
    if (c == "\"") { P++; return out }
    if (c == "\\") {
      e = substr(S, P + 1, 1)
      if (e == "n" || e == "r" || e == "t" || e == "b" || e == "f") { out = out " "; P += 2 }
      else if (e == "\"" || e == "\\" || e == "/") { out = out e; P += 2 }
      else if (e == "u") {
        cp = hexval(substr(S, P + 2, 4)); P += 6
        if (cp >= 55296 && cp < 56320 && substr(S, P, 2) == "\\u") {
          lo = hexval(substr(S, P + 2, 4))
          if (lo >= 56320 && lo < 57344) { cp = 65536 + (cp - 55296) * 1024 + (lo - 56320); P += 6 }
          else cp = 63
        } else if (cp >= 55296 && cp < 57344) cp = 63
        out = out utf8(cp)
      } else bad()
    } else if (c in ctl) { out = out " "; P++ }
    else { out = out c; P++ }
  }
}
function scalar(   start, c) {
  start = P
  while (P <= N) { c = substr(S, P, 1); if (index(",}] \t\n\r", c) > 0) break; P++ }
  if (P == start) bad()
  return substr(S, start, P - start)
}
# Parse a value at P. emit: print scalars under name.
function val(depth, name, emit,   c, v) {
  ws()
  c = substr(S, P, 1)
  if (c == "{") { obj(depth); return }
  if (c == "[") { arr(depth, name, emit); return }
  if (c == "\"") v = str(); else v = scalar()
  if (emit) print name "=" v
}
function obj(depth,   k, c) {
  P++
  ws()
  if (substr(S, P, 1) == "}") { P++; return }
  while (1) {
    ws(); k = str(); ws()
    if (substr(S, P, 1) != ":") bad()
    P++
    val(depth + 1, k, depth == 0)
    ws(); c = substr(S, P, 1); P++
    if (c == "}") return
    if (c != ",") bad()
  }
}
function arr(depth, name, emit,   c) {
  P++
  ws()
  if (substr(S, P, 1) == "]") { P++; return }
  while (1) {
    val(depth + 1, name "[]", emit && depth == 1)
    ws(); c = substr(S, P, 1); P++
    if (c == "]") return
    if (c != ",") bad()
  }
}
BEGIN { for (i = 1; i < 32; i++) ctl[sprintf("%c", i)] = 1; ctl[sprintf("%c", 127)] = 1 }
{ S = S $0 "\n" }
END {
  if (err) exit 3
  N = length(S); P = 1
  ws()
  if (substr(S, P, 1) != "{") exit 3
  obj(0)
}'

# --- output helpers -------------------------------------------------------------------------

CTL_TOKEN=

redact() { CFO_CTL=$CTL_TOKEN awk "$REDACT_AWK"; }

say() { printf '%s\n' "$*" | redact; }

# fail <message> [exit code]. One final line on stdout and stderr. Worker errors already start
# with "Failed: "; drop it so the line has one prefix.
fail() {
  msg=$1
  while :; do
    case $msg in "Failed: "*) msg=${msg#"Failed: "} ;; *) break ;; esac
  done
  line=$(printf 'Failed: %s\n' "$msg" | redact)
  printf '%s\n' "$line"
  printf '%s\n' "$line" >&2
  exit "${2:-1}"
}

# Printable, bounded form of an untrusted value for messages.
clean() {
  printf '%s' "$1" | awk '{ gsub(/[^A-Za-z0-9._:\/-]/, "?"); s = s (NR > 1 ? "?" : "") $0 } END { print substr(s, 1, 64) }'
}

# First value of `key` from JSON_AWK output in $1.
field() { printf '%s\n' "$1" | sed -n "s/^$2=//p" | sed -n '1p'; }

now() { date +%s; }

# --- input checks ---------------------------------------------------------------------------

OP=${ORB_OPERATION:-}
ORB=${ORB_ID:-}
say "cf-orbs: $(clean "$OP") $(clean "$ORB")"

case $OP in
  spawn | pause | delete) ;;
  *) fail "unknown ORB_OPERATION '$(clean "$OP")' — fix: update cf-orbs (npx cf-orbs@latest deploy)" 2 ;;
esac

# Same rule as the server: ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$
orb_ok=1
case $ORB in
  "" | [!A-Za-z0-9]* | *[!A-Za-z0-9_-]*) orb_ok=0 ;;
esac
[ "${#ORB}" -le 128 ] || orb_ok=0
[ "$orb_ok" = 1 ] || fail "invalid orb id '$(clean "$ORB")' — fix: check ORB_ID from Amp" 2

BASE=${CF_ORBS_URL:-http://control.internal}
while :; do
  case $BASE in */) BASE=${BASE%/} ;; *) break ;; esac
done
case $BASE in
  http://?* | https://?*) ;;
  *) fail "CF_ORBS_URL '$(clean "$BASE")' is not an http(s) URL — fix: set CF_ORBS_URL to the Worker URL" 2 ;;
esac
case $BASE in
  *[!A-Za-z0-9._:/~%-]*) fail "CF_ORBS_URL has characters outside [A-Za-z0-9._:/~%-] — fix: set CF_ORBS_URL to the Worker URL" 2 ;;
esac
host=${BASE#*://}
host=${host%%/*}
host=${host%%:*}

# The body carries ORB_TOKEN and the header the control token: plain http only on the internal
# hostname or this machine.
case $BASE in
  http://*)
    case $host in
      control.internal | localhost | 127.0.0.1) ;;
      *) fail "CF_ORBS_URL must use https for $(clean "$host") — fix: set CF_ORBS_URL to https://<your Worker host>" 2 ;;
    esac
    ;;
esac

if [ "$host" != control.internal ]; then
  CTL_TOKEN=${CF_ORBS_CONTROL_TOKEN:-}
  if [ -z "$CTL_TOKEN" ] && [ -n "${CF_ORBS_CONTROL_TOKEN_FILE:-}" ]; then
    [ -r "$CF_ORBS_CONTROL_TOKEN_FILE" ] ||
      fail "cannot read CF_ORBS_CONTROL_TOKEN_FILE — fix: check the file path and its permissions" 2
    IFS= read -r CTL_TOKEN <"$CF_ORBS_CONTROL_TOKEN_FILE" || [ -n "$CTL_TOKEN" ]
    CTL_TOKEN=${CTL_TOKEN%"$CR"}
  fi
  [ -n "$CTL_TOKEN" ] ||
    fail "no control token for $host — fix: set CF_ORBS_CONTROL_TOKEN or CF_ORBS_CONTROL_TOKEN_FILE to the Worker CONTROL_TOKEN" 2
  case $CTL_TOKEN in
    *[!A-Za-z0-9._~+/=-]*) fail "control token has characters outside [A-Za-z0-9._~+/=-] — fix: set a new CONTROL_TOKEN with cf-orbs deploy" 2 ;;
  esac
fi

LIMIT=${CF_ORBS_DEADLINE_SECONDS:-270}
case $LIMIT in
  "" | *[!0-9]*) fail "CF_ORBS_DEADLINE_SECONDS '$(clean "$LIMIT")' is not a number — fix: unset it (default 270)" 2 ;;
esac
if [ "$LIMIT" -lt 1 ] || [ "$LIMIT" -gt 3600 ]; then
  fail "CF_ORBS_DEADLINE_SECONDS must be 1..3600 — fix: unset it (default 270)" 2
fi
START=$(now)
DEADLINE=$((START + LIMIT))

# --- HTTP -----------------------------------------------------------------------------------

# curl config on stdin: URL, auth header and body never appear in argv.
curl_config() {
  printf 'url = "%s"\n' "$1"
  if [ -n "$CTL_TOKEN" ]; then printf 'header = "Authorization: Bearer %s"\n' "$CTL_TOKEN"; fi
  if [ -n "$2" ]; then
    printf 'header = "Content-Type: application/json"\n'
    printf 'data-binary = "%s"\n' "$2"
  fi
}

curl_cause() {
  case $1 in
    6) echo "cannot resolve host" ;;
    7) echo "connection refused" ;;
    28) echo "timed out" ;;
    35 | 51 | 58 | 60) echo "TLS error" ;;
    52) echo "empty reply" ;;
    55 | 56) echo "connection reset" ;;
    *) echo "curl exit $1" ;;
  esac
}

# request <url> <config-escaped body or empty> <max seconds>
# Sets CODE and RESP. Retries curl errors, 408, 429 and 5xx: 3 attempts, 2 s apart, within the
# deadline. Returns 1 when no HTTP response came back (CAUSE says why).
request() {
  attempt=1
  while :; do
    out=$(curl_config "$1" "$2" | curl -q -sS -g -K - -m "$3" -w '\n%{http_code}' 2>/dev/null)
    rc=$?
    CODE=${out##*"$NL"}
    RESP=${out%"$NL"*}
    [ "$out" = "$CODE" ] && RESP=
    if [ "$rc" -eq 0 ]; then
      case $CODE in
        408 | 429 | 5??) CAUSE="HTTP $CODE" ;;
        *) return 0 ;;
      esac
    else
      CAUSE=$(curl_cause "$rc")
      CODE=000
    fi
    if [ "$attempt" -ge 3 ] || [ $(($(now) + 2)) -ge "$DEADLINE" ]; then
      [ "$CODE" = 000 ] && return 1
      return 0
    fi
    say "control plane: $CAUSE, retry $attempt of 2"
    attempt=$((attempt + 1))
    sleep 2
  done
}

# Message for a non-2xx answer. Uses the server error text when present.
http_error() {
  err=$(printf '%s\n' "$RESP" | awk "$JSON_AWK" 2>/dev/null)
  err=$(field "$err" error)
  case $CODE in
    401 | 403) fail "control plane rejected the control token (HTTP $CODE) — fix: set CF_ORBS_CONTROL_TOKEN to the Worker CONTROL_TOKEN" ;;
  esac
  if [ -n "$err" ]; then
    case $err in
      *"fix:"*) fail "$err" ;;
      *) fail "$err (HTTP $CODE) — fix: $1" ;;
    esac
  fi
  case $CODE in
    404) fail "control plane answered 404 for $2 — fix: check CF_ORBS_URL; in external mode set CONTROL_TOKEN on the Worker" ;;
  esac
  fail "control plane answered HTTP $CODE for $2 — fix: $1"
}

# --- post the op ----------------------------------------------------------------------------

BODY=$(awk "$BODY_AWK" </dev/null)
BODY_CFG=$(printf '%s\n' "$BODY" | sed 's/[\\"]/\\&/g')

request "$BASE/v1/orbs/$ORB/ops" "$BODY_CFG" 30 ||
  fail "control plane unreachable at $BASE ($CAUSE, 3 attempts) — fix: run cf-orbs status; check the Worker is deployed"
case $CODE in
  2??) ;;
  *) http_error "cf-orbs logs $ORB" "POST /v1/orbs/$ORB/ops" ;;
esac

parsed=$(printf '%s\n' "$RESP" | awk "$JSON_AWK" 2>/dev/null) ||
  fail "control plane sent an unreadable reply to POST ops — fix: update cf-orbs; check cf-orbs logs $ORB"
OPID=$(field "$parsed" opId)
case $OPID in
  "" | *[!A-Za-z0-9._:-]*) fail "control plane sent no valid opId — fix: update cf-orbs; check cf-orbs logs $ORB" ;;
esac
if [ "$(field "$parsed" attached)" = true ]; then
  say "attaching to running $OP $OPID"
else
  say "started $OP $OPID"
fi

# --- long-poll ------------------------------------------------------------------------------

PRINTED=0
while :; do
  t0=$(now)
  left=$((DEADLINE - t0))
  [ "$left" -gt 0 ] || fail "control plane did not finish $OP within $LIMIT s — fix: cf-orbs logs $ORB"
  pollwait=20
  [ "$left" -le 20 ] && pollwait=$((left - 1))
  maxt=$((pollwait + 10))
  [ "$maxt" -gt "$left" ] && maxt=$left
  [ "$maxt" -lt 2 ] && maxt=2

  request "$BASE/v1/ops/$OPID?wait=$pollwait&since=$PRINTED" "" "$maxt" ||
    fail "control plane unreachable at $BASE while waiting for $OP ($CAUSE) — fix: cf-orbs logs $ORB"
  case $CODE in
    200) ;;
    404) fail "op $OPID is unknown to the control plane — fix: retry the message; cf-orbs logs $ORB" ;;
    *) http_error "cf-orbs logs $ORB" "GET /v1/ops/$OPID" ;;
  esac

  parsed=$(printf '%s\n' "$RESP" | awk "$JSON_AWK" 2>/dev/null) ||
    fail "control plane sent an unreadable op status — fix: update cf-orbs; check cf-orbs logs $ORB"

  lines=$(printf '%s\n' "$parsed" | sed -n 's/^progress\[\]=//p')
  fresh=0
  if [ -n "$lines" ]; then
    total=$(printf '%s\n' "$lines" | awk 'END { print NR }')
    if [ "$total" -gt "$PRINTED" ]; then
      printf '%s\n' "$lines" | awk -v skip="$PRINTED" 'NR > skip' | redact
      PRINTED=$total
      fresh=1
    fi
  fi

  phase=$(field "$parsed" phase)
  case $phase in
    succeeded)
      say "cf-orbs: $OP $ORB done in $(($(now) - START)) s"
      exit 0
      ;;
    failed)
      err=$(field "$parsed" error)
      [ -n "$err" ] || err="$OP failed"
      case $err in
        *"fix:"*) fail "$err" ;;
        *) fail "$err — fix: cf-orbs logs $ORB" ;;
      esac
      ;;
    queued | running) ;;
    *) fail "control plane sent unknown op phase '$(clean "$phase")' — fix: update cf-orbs" ;;
  esac

  # A server that answers at once (no long-poll) must not make this a busy loop. A reply with new lines
  # is a long-poll wake-up: poll again at once, or the end of the op can wait up to 1 s here.
  [ "$fresh" = 1 ] || [ "$(now)" -gt "$t0" ] || sleep 1
done
