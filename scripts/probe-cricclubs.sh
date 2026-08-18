#!/usr/bin/env bash
# Does a CI runner get past Cloudflare on CricClubs? Diagnostic only.
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

probe () {
  local label="$1" url="$2" f=/tmp/cc.html
  local code
  code=$(curl -sS -o "$f" -w "%{http_code}" --max-time 30 \
    -A "$UA" \
    -H 'Accept: text/html,application/xhtml+xml' \
    -H 'Accept-Language: en-CA,en;q=0.9' \
    "$url" 2>/dev/null || echo 000)
  local bytes result
  bytes=$(wc -c < "$f" 2>/dev/null || echo 0)
  if grep -qiE 'just a moment|security verification|challenge-platform|cf-mitigated' "$f" 2>/dev/null; then
    result="CLOUDFLARE-CHALLENGE"
  elif grep -qiE 'Wkts|Overs|Runs' "$f" 2>/dev/null; then
    result="DATA-OK"
  else
    result="UNKNOWN"
  fi
  echo "$label | HTTP $code | $bytes bytes | $result"
}

echo "=== CricClubs reachability from GitHub Actions ==="
probe "MCL bowling-by-year" "https://cricclubs.com/MississaugaCricketLeague/playerBowlingRecordsGroupByYear.do?clubId=2565&seriesType=T25&playerId=2793593"
probe "MCL player profile  " "https://cricclubs.com/MississaugaCricketLeague/viewPlayer.do?playerId=2793593&clubId=2565"
probe "LCL league root     " "https://cricclubs.com/LCL/"
echo "=== end ==="
