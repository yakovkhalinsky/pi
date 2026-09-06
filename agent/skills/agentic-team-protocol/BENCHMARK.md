# ATP performance benchmark

Measured baseline for protocol speed, captured **2026-09-06** before the
router-fast-path / record-merge / 1s-poller changes. Re-run the procedure
below after protocol changes and diff against these numbers.

## Method

1. **Stage timelines** — Eden-memory records per goal carry `created_at`;
   consecutive-record gaps show where wall-time goes (real work vs routing
   overhead vs memory I/O).
2. **Role-run durations** — the session's `.subagents/manifest.jsonl` carries
   `started`/`finished` events per episode; child transcripts count tool calls.
3. **CLI latency** — each wrapper op timed ×3 against a scratch DB
   (`--db /tmp/atp-bench/bench.db`), never the default DB.

## Baseline numbers (2026-09-06)

### Role subagent runs (pi session manifests, eden-memory workspace session)

49 runs over 7,322s ≈ 122 min (multiple goals):

| Role | Runs | Avg duration | Share of runs |
|------|------|-------------|---------------|
| **router** | **~22** | **~80s (40–151s)** | **~45%** |
| dispatcher | 8 | ~90s | 16% |
| verifier | 7 | ~145s | 14% |
| archivist | 4 | ~137s | 8% |
| builder | 2 | ~275s | 4% |
| runtime | 2 | ~275s | 4% |
| researcher | 3 | ~650s | 6% |

Earlier session (36 runs / 3,084s): router = 15 runs ≈ 845s ≈ **27%** of
subagent wall-time. **One router pass per role transition, ~80s each.**

### Record mix per goal (workspace eden-memory, 6 goals)

`hand_off_record` + `run_log` = **63–75% of all records**; substance
(dispatch/action/verdict/archival) is the remainder. Largest goals: 32
records (setup-env-hazard, 27m), 28 (rebrand-alternatives-scan, 35m).

### Eden-memory CLI latency (scratch DB, ×3)

| op | latency |
|----|---------|
| `remember` | ~1.0s (embedding) |
| `recall` | ~1.0s (query embedding) |
| `search` / `lookup` | ~0.5s |
| `edit` | ~0.5–1.0s |
| `health` | ~0.01s |
| raw sqlite3 select | ~0.00s |

→ **~20–30s of memory I/O per goal (~20–32 writes) — ~1% of goal wall-time.
Memory I/O is NOT the bottleneck.**

### Derived baseline metrics (what to compare after changes)

- **Router tax**: ~80s × 1 router pass per transition; ~7 transitions per
  goal ≈ **8–10 min/goal**, ~25–30% of subagent wall-time.
- **Bookkeeping record ratio**: hand_off+run_log / all records ≈ **0.7**.
- **Memory-write volume**: ~20–32 records per goal.
- **Goal wall-clock**: 7m39s (minimal goal) → 27–35m (multi-stage goals).
- **Widget refresh**: 2s poller.

## Re-measure procedure

```bash
# role runs + durations (latest sessions):
python3 - <<'EOF'
import json, glob, os
from datetime import datetime as D
for d in sorted(glob.glob(os.path.expanduser("~/.pi/agent/sessions/*/*.jsonl.subagents")), key=os.path.getmtime)[-3:]:
    mf = os.path.join(d, "manifest.jsonl")
    if not os.path.exists(mf): continue
    runs = {}
    for line in open(mf):
        try: r = json.loads(line)
        except: continue
        ep = r.get("episodeId")
        if r.get("type") in ("started","resume_started") and ep:
            runs.setdefault(ep, {"agent": r.get("agent"), "start": r.get("startedAt")})
        elif r.get("type") in ("finished","resume_finished") and ep in runs:
            runs[ep]["end"] = r.get("finishedAt")
    agg = {}
    for ep, r in runs.items():
        if r.get("start") and r.get("end"):
            dur = (D.fromisoformat(r["end"].replace("Z","+00:00")) - D.fromisoformat(r["start"].replace("Z","+00:00"))).total_seconds()
            a = r["agent"]; agg.setdefault(a, []).append(dur)
    for a, ds in sorted(agg.items()):
        print(f"{a:12} runs={len(ds):3} avg={sum(ds)/len(ds):6.0f}s total={sum(ds):7.0f}s")
EOF

# CLI latency (scratch DB — never the default DB):
mkdir -p /tmp/atp-bench && rm -f /tmp/atp-bench/bench.db
# time eden-memory remember/recall/search/lookup ×3 with --db /tmp/atp-bench/bench.db

# record mix:
sqlite3 ~/.eden-memory/default.db "SELECT json_extract(metadata,'$.record_type'), count(*) FROM memories WHERE workspace_id='<ws>' AND deleted_at=0 AND json_extract(metadata,'$.goal_id') IS NOT NULL GROUP BY 1 ORDER BY 2 DESC;"
```

## Changes measured against this baseline

| Change | Expected effect |
|--------|----------------|
| Router fast-path (parent spawns the hand-off's named next role directly) | −1 router run per transition → −25–30% subagent wall-time on multi-stage goals |
| Turn-end run_log merged into the hand-off | −1 LLM turn + −1 record write per stage |
| Widget poller 2s → 1s | live activity updates near-real-time (UI latency, not goal time) |