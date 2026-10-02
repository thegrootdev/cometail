#!/usr/bin/env bash
# Runs every test file in its own process, one at a time. A single mocha process holding
# every LiteSVM instance (each loads the mainnet Meteora binaries) grows past 3 GB and gets
# killed on a small box; per-file processes stay under 1 GB and the memory is released
# between files. Usage: bash run-sequential.sh [pattern...]  (default: smoke, regression, gates)
set -u
cd "$(dirname "$0")"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1536}"
files=()
if [ $# -gt 0 ]; then
  for p in "$@"; do while IFS= read -r f; do files+=("$f"); done < <(find . -path ./node_modules -prune -o -name "*.test.ts" -print | grep -E "$p" | sort); done
else
  while IFS= read -r f; do files+=("$f"); done < <({ ls harness/*.test.ts; ls regression/*.test.ts; ls gates/*.test.ts; } 2>/dev/null)
fi
if [ ${#files[@]} -eq 0 ]; then echo "no test files matched"; exit 1; fi
failed=()
pass=0
start=$(date +%s)
for f in "${files[@]}"; do
  echo "=== $f"
  if pnpm exec ts-mocha --exit -p ./tsconfig.json -t 1000000 "$f"; then pass=$((pass + 1)); else failed+=("$f"); fi
done
echo "=== files passed: $pass/${#files[@]} in $(( $(date +%s) - start ))s"
if [ ${#failed[@]} -gt 0 ]; then printf 'FAILED: %s\n' "${failed[@]}"; exit 1; fi
