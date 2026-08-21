import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

export type RequestLog = {
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  remoteKey: string;
  errorCode?: string;
};

/** Logs request metadata only. Operation payloads and credentials are excluded. */
export function logRequest(entry: RequestLog): void {
  const record = { level: entry.status >= 500 ? "error" : entry.status >= 400 ? "warn" : "info", event: "http_request", at: new Date().toISOString(), ...entry };
  console.log(JSON.stringify(record));
}

export function requestId(header: string | string[] | undefined): string {
  const supplied = Array.isArray(header) ? header[0] : header;
  return supplied && /^[A-Za-z0-9._-]{8,120}$/u.test(supplied) ? supplied : randomUUID();
}

type Window = { startedAt: number; count: number };

/** Bounded in-memory rate limiter. Deployments should also rate-limit at the TLS edge. */
export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, Window>();
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly maxKeys = 20_000) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("rate limit must be a positive integer");
    if (!Number.isSafeInteger(windowMs) || windowMs < 1_000) throw new Error("rate window must be at least one second");
  }

  allow(key: string, at = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    if (this.windows.size > this.maxKeys) this.prune(at);
    const current = this.windows.get(key);
    if (!current || at - current.startedAt >= this.windowMs) {
      this.windows.set(key, { startedAt: at, count: 1 });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    current.count += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((this.windowMs - (at - current.startedAt)) / 1_000));
    return { allowed: current.count <= this.limit, retryAfterSeconds };
  }

  private prune(at: number): void {
    for (const [key, value] of this.windows) if (at - value.startedAt >= this.windowMs) this.windows.delete(key);
    if (this.windows.size <= this.maxKeys) return;
    for (const key of this.windows.keys()) {
      this.windows.delete(key);
      if (this.windows.size <= this.maxKeys) break;
    }
  }
}

export class SyncMetrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  increment(name: "requests_total" | "push_operations_total" | "pull_events_total" | "conflicts_total" | "rejected_total" | "errors_total", value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  set(name: "ready" | "inflight_requests", value: number): void { this.gauges.set(name, value); }

  render(): string {
    const lines: string[] = [];
    for (const [name, value] of [...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b))) lines.push(`# TYPE ledgr_sync_${name} counter`, `ledgr_sync_${name} ${value}`);
    for (const [name, value] of [...this.gauges.entries()].sort(([a], [b]) => a.localeCompare(b))) lines.push(`# TYPE ledgr_sync_${name} gauge`, `ledgr_sync_${name} ${value}`);
    return `${lines.join("\n")}\n`;
  }
}

export function remoteRateKey(address: string | undefined): string {
  return createHash("sha256").update(address || "unknown").digest("hex").slice(0, 24);
}

export function safeTokenEqual(received: string | undefined, expected: string | undefined): boolean {
  if (!received || !expected) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
