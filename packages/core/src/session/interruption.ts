export * as SessionInterruption from "./interruption.js"

import { Context } from "effect"

/**
 * Why the running Session execution is being interrupted: `"user"` when someone stopped it, otherwise undefined
 * (teardown, such as a server shutdown or a Location closing, interrupts without a reason). Work in the execution
 * reads it to tell a user's stop from teardown.
 */
export const Reason = Context.Reference<() => "user" | "shutdown" | undefined>("@opencode/SessionInterruption", {
  defaultValue: () => () => undefined,
})
