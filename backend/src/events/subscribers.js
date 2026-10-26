// Ready-made subscribers. Each attaches to a bus and returns an unsubscribe function.

// "llm_call" is bookkeeping for counters, not progress to show a user.
const isProgress = (event) => event.type !== "llm_call";

// Calls `handler` for every progress event.
export function onProgress(bus, handler) {
  return bus.subscribe("*", (event) => {
    if (isProgress(event)) handler(event);
  });
}

// Prints progress events. `format(event)` returns the line, or null to skip it.
export function logToConsole(bus, format = (e) => `[${e.type}] ${e.message}`) {
  return onProgress(bus, (event) => {
    const line = format(event);
    if (line != null) console.log(line);
  });
}

// Keeps progress events in `history` for the status endpoints to return.
export function recordHistory(bus, history) {
  return onProgress(bus, (event) => history.push(event));
}

// Counts LLM calls made while attached. `onChange(count)` is optional.
export class LlmUsageCounter {
  count = 0;

  constructor(onChange) {
    this.onChange = onChange;
  }

  attach(bus) {
    return bus.subscribe("llm_call", () => {
      this.count++;
      this.onChange?.(this.count);
    });
  }
}
