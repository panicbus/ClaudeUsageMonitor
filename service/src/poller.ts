import type { UsageResponse } from "@claude-usage-monitor/shared";

export interface Poller {
  getSnapshot: () => UsageResponse;
  stop: () => void;
}

export function startPolling(
  buildSnapshot: () => Promise<UsageResponse>,
  intervalMs: number,
  initialSnapshot: UsageResponse,
): Poller {
  let snapshot = initialSnapshot;
  let seq = 0;
  let appliedSeq = 0;
  let inFlight = false;
  let stopped = false;

  function poll() {
    if (inFlight || stopped) return;
    inFlight = true;
    const mySeq = ++seq;

    buildSnapshot()
      .then((next) => {
        if (stopped) return;
        if (mySeq > appliedSeq) {
          appliedSeq = mySeq;
          snapshot = next;
        }
      })
      .catch(() => {
        // buildUsageResponse already reports upstream failures via
        // service.status; an unexpected rejection here just means this
        // tick's data is lost, not that the whole poller should stop.
      })
      .finally(() => {
        inFlight = false;
      });
  }

  poll();
  const timer = setInterval(poll, intervalMs);

  return {
    getSnapshot: () => snapshot,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
