import { AsyncLocalStorage } from "async_hooks";

// Observer pattern: code publishes events to a bus and doesn't know who is
// listening. Destinations (console, history, counters, a future SSE stream)
// subscribe to the bus instead of being passed down as callbacks.
export class EventBus {
  #handlers = new Map(); // type -> Set of handlers; "*" receives every event

  // Returns an unsubscribe function.
  subscribe(type, handler) {
    if (!this.#handlers.has(type)) this.#handlers.set(type, new Set());
    this.#handlers.get(type).add(handler);
    return () => this.#handlers.get(type)?.delete(handler);
  }

  // Builds { at, type, message, ...data } and delivers it to the subscribers of
  // that type and to "*". A failing subscriber never breaks the publisher.
  emit(type, message, data = {}) {
    const event = { at: new Date().toISOString(), type, message, ...data };
    for (const key of [type, "*"]) {
      for (const handler of [...(this.#handlers.get(key) || [])]) {
        try {
          handler(event);
        } catch (err) {
          console.error(`Event subscriber failed on "${type}":`, err);
        }
      }
    }
    return event;
  }
}

// The bus of the scan/run currently executing. Lets code deep in the call
// stack (e.g. the LLM client) publish events without a bus parameter being
// threaded through every function.
const context = new AsyncLocalStorage();

export const runWithBus = (bus, fn) => context.run(bus, fn);
export const currentBus = () => context.getStore() ?? null;
