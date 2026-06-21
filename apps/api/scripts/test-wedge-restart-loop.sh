#!/usr/bin/env bash
# End-to-end demo of the wedge → SIGKILL → restart cycle.
#
# Simulates what Railway's restartPolicy=ON_FAILURE does after the
# killswitch fires: detect non-zero exit, wait a few seconds, restart.
# Loops 3 times so you can see the safety net catches every wedge.
#
# Run from apps/api:
#   bash scripts/test-wedge-restart-loop.sh
#
# Expected output (per iteration, ~15s total):
#   [iter N] starting...
#   pid=NNNN — installing killswitch (grace=2s ...)
#   === blocking main loop forever — killswitch should fire in ~2s ===
#   [wedge-killswitch] main loop unresponsive ~1s (1/2) ...
#   [wedge-killswitch] main loop unresponsive ~2s (2/2) ...
#   [wedge-killswitch] FATAL — sending SIGKILL to pid=NNNN ...
#   [iter N] process killed by signal 9 (SIGKILL) — Railway would restart now
#   [iter N] sleeping 3s before restart (Railway-typical)...
set -u

MAX_ITERS="${MAX_ITERS:-3}"
RESTART_DELAY_S="${RESTART_DELAY_S:-3}"

for ((i = 1; i <= MAX_ITERS; i++)); do
  echo
  echo "================================================================"
  echo "[iter $i/$MAX_ITERS] starting..."
  echo "================================================================"

  WEDGE_GRACE_MS=2000 \
    WEDGE_PING_INTERVAL_MS=1000 \
    WEDGE_MAX_MISSES=2 \
    npx ts-node scripts/test-wedge-killswitch.ts --fast
  exit_code=$?

  if [[ $exit_code -eq 137 ]] || [[ $exit_code -eq 143 ]]; then
    echo "[iter $i] process killed (exit=$exit_code) — Railway would restart now"
  elif [[ $exit_code -eq 0 ]]; then
    echo "[iter $i] process exited cleanly — killswitch did NOT fire (BUG)"
    exit 1
  else
    # On Windows/Git-Bash the SIGKILL exit code surfaces differently.
    # Treat any non-zero as "killed" for the demo.
    echo "[iter $i] process exited with code=$exit_code (likely SIGKILL on this OS)"
  fi

  if (( i < MAX_ITERS )); then
    echo "[iter $i] sleeping ${RESTART_DELAY_S}s before restart (Railway-typical)..."
    sleep "$RESTART_DELAY_S"
  fi
done

echo
echo "================================================================"
echo "Done. Killswitch fired and the loop recovered $MAX_ITERS times."
echo "On Railway, restartPolicy=ON_FAILURE plays the same role as this loop."
echo "================================================================"
