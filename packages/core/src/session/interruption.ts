export * as SessionInterruption from "./interruption.js"

import { Context } from "effect"

/**
 * Why the running Session execution is being interrupted, read once it is: `"user"` when someone stopped it,
 * `"shutdown"` when the server tore it down. Undefined outside a Session execution. Work in the execution reads it
 * to tell a user's stop from teardown.
 */
export const Reason = Context.Reference<() => "user" | "shutdown" | undefined>("@opencode/SessionInterruption", {
  defaultValue: () => () => undefined,
})
