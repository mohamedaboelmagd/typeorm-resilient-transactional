---
'typeorm-resilient-transactional': patch
---

Stop a failing diagnostic handler from breaking the caller.

`setDiagnosticHandler()` takes a `(event) => void`, and the docs point you at a NestJS `Logger` or pino — so `setDiagnosticHandler(async (event) => log.send(event))` is an easy thing to write, and TypeScript accepts it. The handler was called bare: one that threw surfaced from whatever library code happened to be warning at the time, including from inside a `catch` that was already handling a different failure, and one that rejected became an unhandled rejection, which terminates the process on Node 15+.

That made the channel used to report every other failure the one most able to cause one. A logging outage could take down the service.

The handler's throw or rejection is now absorbed. Nothing is reported when it fails, deliberately: the only channel out is the handler that just failed, and calling it again would recurse. Diagnostics keep working afterwards — a failure does not disable the handler.

This is the same defect as the `onRetry` / `onExhausted` / `runOnRetry` fix in 0.1.1, found by sweeping for the pattern rather than waiting for it to be reported. `onCommit`, `onRollback`, and every `RetryMetrics` method were already covered by that fix.
