export * as ToolInterrupted from "./interrupted.js"

import { Context, Effect } from "effect"
import type { Tool } from "@opencode/schema/tool"

/**
 * Lets a tool whose call is interrupted settle it with its own failure, e.g. the output it had so far.
 *
 * Once its fiber is interrupted, a tool's failure never reaches the session step: the first interruptible effect
 * after the tool (the `execute.after` hook, for one) aborts with the interrupt. So the tool reports the failure
 * here instead, and the step records it in place of the generic "interrupted" one. The step still ends as
 * interrupted.
 */
export type Slot = { failure?: Tool.Error }

export const Slot = Context.Reference<Slot | undefined>("@opencode/ToolInterrupted/Slot", {
  defaultValue: () => undefined,
})

export const report = Effect.fnUntraced(function* (failure: Tool.Error) {
  const slot = yield* Slot
  if (slot) slot.failure = failure
})
