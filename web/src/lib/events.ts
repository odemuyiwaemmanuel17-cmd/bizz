/**
 * Tiny cross-component event bus used to keep pages in sync after mutations.
 *
 * The app deliberately avoids a heavyweight state library (no React Query /
 * Zustand): data hooks already own their fetch/refetch logic, and publishing
 * or deleting a listing just needs to tell every mounted page "your cache is
 * stale". A `BroadcastChannel` wrapper gives us that across components — and
 * even across browser tabs — with zero dependencies.
 */

export const BIZZ_EVENTS: ReadonlyArray<string> = ["published", "updated", "deleted"] as const;
export type BizzEventName = (typeof BIZZ_EVENTS)[number];

export interface BizzEventPayload {
  readonly kind: BizzEventName;
  /** id of the affected listing/idea when known. */
  readonly id?: string;
  /** true when a concept (ideas table) was affected rather than a listing. */
  readonly isConcept?: boolean;
}

const CHANNEL_NAME: string = "bizz-events";

let channel: BroadcastChannel | null = null;
try {
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(CHANNEL_NAME);
  }
} catch {
  // Environments without BroadcastChannel degrade to no-op broadcasting.
  channel = null;
}

type Listener = (payload: BizzEventPayload) => void;
const listeners: Map<BroadcastChannel, Set<Listener>> = new Map();

if (channel !== null) {
  // Internal registry so multiple subscribe() calls share one native handler.
  listeners.set(channel, new Set());
  channel.onmessage = (event: MessageEvent<BizzEventPayload>): void => {
    const set = listeners.get(channel as BroadcastChannel);
    if (set === undefined) return;
    for (const fn of set) {
      try {
        fn(event.data);
      } catch (err: unknown) {
        console.warn("[bizz-events] listener failed:", err);
      }
    }
  };
}

/** Emits a mutation event to all subscribers (same tab + other tabs). */
export function emitBizzEvent(payload: BizzEventPayload): void {
  if (channel === null) return;
  try {
    channel.postMessage(payload);
  } catch (err: unknown) {
    console.warn("[bizz-events] post failed:", err);
  }
}

/** Subscribes to bizz mutation events. Returns an unsubscribe function. */
export function subscribeToBizzEvents(onEvent: Listener): () => void {
  if (channel === null) return () => undefined;
  const set = listeners.get(channel);
  if (set === undefined) return () => undefined;
  set.add(onEvent);
  return (): void => {
    set.delete(onEvent);
  };
}
