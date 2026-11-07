export interface ScrollPositionAdapter {
  setScrollTop(target: number): Promise<void>;
  readScrollMetrics(): Promise<{ position: number; maximum: number }>;
  settleFrame(): Promise<void>;
}

export interface PositionScrollOptions {
  tolerance?: number;
  pollAttempts?: number;
  pollDelayMs?: number;
}

export interface SettledScrollPosition {
  position: number;
  target: number;
  maximum: number;
}

export async function positionScroll(adapter: ScrollPositionAdapter, requestedTarget: number,
  options: PositionScrollOptions = {}): Promise<SettledScrollPosition> {
  const tolerance = options.tolerance ?? 1;
  const pollAttempts = options.pollAttempts ?? 20;
  const pollDelayMs = options.pollDelayMs ?? 10;
  await adapter.setScrollTop(requestedTarget);
  await adapter.settleFrame();
  await adapter.settleFrame();
  let latest = await adapter.readScrollMetrics();
  for (let attempt = 0; attempt < pollAttempts; attempt++) {
    latest = await adapter.readScrollMetrics();
    const target = Math.max(0, Math.min(latest.maximum, requestedTarget));
    if (Math.abs(latest.position - target) <= tolerance) return { ...latest, target };
    if (pollDelayMs > 0) await new Promise(resolve => setTimeout(resolve, pollDelayMs));
  }
  const target = Math.max(0, Math.min(latest.maximum, requestedTarget));
  throw new Error(`scroll position did not settle: position=${latest.position}, target=${target}, maximum=${latest.maximum}`);
}
