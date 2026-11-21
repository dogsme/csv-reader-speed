# Fast CSV Reader

A fast drop-in replacement for make.fun's csv-reader 1.0.0, written for the
"Read broken CSV files faster, 21 November 2026" bounty ($100 in USDC). It
answers every case exactly as csv-reader 1.0.0 does — same broken-row policy,
same {columns, rows, errors} — and reads each field's plain run with a
scanning loop and a single slice instead of a character at a time.

Run: `node main.ts` with MAKEFUN_INPUT_DIR holding cases.json; it writes
answers.json to MAKEFUN_OUTPUT_DIR (the /input and /output mounts in the
grader's container).
