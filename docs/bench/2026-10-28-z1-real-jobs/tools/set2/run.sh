#!/usr/bin/env bash
# run.sh <job-name> — one job through `casemaker cut` headless, on the bench clone; summarises the receipt.
set -u
S=/tmp/claude-1000/-mnt-c-projects-Case-Maker/1f3de4db-a6fc-40f6-b616-3bca2af6697a/scratchpad/real3
name=$1; shift
out=$S/runs/$name
rm -rf "$out"; mkdir -p "$out"
cd ~/projects/CaseMaker-bench/casemaker-app || exit 9
source ~/.nvm/nvm.sh >/dev/null; nvm use 24 >/dev/null
start=$(date +%s.%N)
timeout ${TMO:-900} npm run -s casemaker -- cut "$S/jobs/$name.json" --out "$out" --json --location "$S/bench/location.json" "$@" \
  > "$out/receipt.json" 2> "$out/stderr.txt"
code=$?
end=$(date +%s.%N)
echo "exit=$code wall=$(python3 -c "print(round($end-$start,1))")s" > "$out/exit.txt"
echo "== $name $(cat $out/exit.txt)"
python3 "$S/../real/summ.py" "$out"
