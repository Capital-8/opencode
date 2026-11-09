export * as ShellTool from "./shell.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import type { ShellCreateBefore } from "@opencode/plugin/effect/shell"
import type { Shell as ShellSchema } from "@opencode/schema/shell"
import type { Tool } from "@opencode/schema/tool"
import { Cause, Deferred, Effect, Exit, Option, Schema } from "effect"
import { Environment } from "../../environment/index.js"
import { Job } from "../../job.js"
import { FileAccess } from "../../file-access.js"
import { Permission } from "../../permission.js"
import { NonNegativeInt } from "../../schema.js"
import { Session } from "../../session.js"
import { SessionInterruption } from "../../session/interruption.js"
import { SessionMessage } from "../../session/message.js"
import { SessionSchema } from "../../session/schema.js"
import { Shell } from "../../shell.js"
import { ShellParse } from "../../shell/parse.js"
import { ShellSelect } from "../../shell/select.js"
import { ShellResult } from "../../shell/result.js"
import { ToolInterrupted } from "../interrupted.js"

export const name = "shell"
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000
// How long a call the user interrupted waits for its stopped command to exit before settling with the output so far.
const INTERRUPT_WAIT = "500 millis"

const BACKGROUND_INSTRUCTION =
  "You will be notified automatically when the command finishes. The notification will include the command's output. Unless the user explicitly asks otherwise, DO NOT poll for completion, even if you need the final result to continue. Repeatedly sleeping and reading or searching the output file is polling, not useful work. You may read the current output if it lets you do useful work now, but do not repeatedly check it while waiting for the command to finish. Keep working on anything that does not depend on the result. If you have nothing else to do, end your response; you will be resumed automatically when the command finishes."
const OS =
  process.platform === "darwin"
    ? "macOS"
    : process.platform === "win32"
      ? "Windows"
      : process.platform === "linux"
        ? "Linux"
        : process.platform
const description = (shell?: string) =>
  [
    "Execute a shell command and return its output.",
    ...(shell ? [`Commands run on ${OS} using ${shell}.`] : []),
    "Quote file paths containing spaces or special characters.",
    "Prefer dedicated tools over shell commands when possible.",
    "When output is large, the full result is saved to a file and a truncated preview is returned.",
    "Rely on automatic truncation unless filtering the output is more useful.",
    "Commands accept an optional timeout, background commands have no timeout by default.",
    "Background commands return immediately, and you will be notified when they complete.",
  ].join(" ")

export const Input = Schema.Struct({
  command: Schema.String.annotate({ description: "Shell command string to execute" }),
  workdir: Schema.optionalKey(Schema.String).annotate({
    description:
      "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
  }),
  timeout: Schema.optionalKey(NonNegativeInt).annotate({
    description: `Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to ${DEFAULT_TIMEOUT_MS} for foreground commands. Background commands have no timeout by default.`,
  }),
  background: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
  }),
})

const StructuredOutput = Schema.Struct({
  exit: Schema.optionalKey(Schema.Number),
  signal: Schema.optionalKey(Schema.String),
  shellID: Schema.optionalKey(Schema.String),
  truncated: Schema.Boolean,
  timeout: Schema.optionalKey(Schema.Boolean),
  killed: Schema.optionalKey(Schema.String),
})

const Output = Schema.Struct({
  ...StructuredOutput.fields,
  output: Schema.String,
  status: Schema.optionalKey(Schema.Literals(["completed", "running"])),
})

type Output = typeof Output.Type

const resultMessages = (output: Output, timeout?: number) => {
  const notice = output.status === "running" ? BACKGROUND_INSTRUCTION : ShellResult.notice(output, timeout)
  return [...(output.output ? [output.output] : []), ...(notice ? [notice] : [])]
}

const toolResult = (output: Output, timeout?: number) => {
  return {
    output,
    content: resultMessages(output, timeout).map((text) => ({ type: "text" as const, text })),
    metadata: {
      status: output.status,
      ...ShellResult.metadata(output),
      ...(output.shellID !== undefined ? { shellID: output.shellID } : {}),
    },
  }
}

const backgroundResult = (shellID: string, file: string) => ({
  output: `Command moved to the background (shell ID: ${shellID}).\nOutput is streaming to: ${file}`,
  shellID,
  truncated: false,
  status: "running" as const,
})

// Tells the session how a background command ended, once its job settles.
const notify = Effect.fnUntraced(function* (
  sessions: Session.Interface,
  jobs: Job.Interface,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly id: string
    readonly shellID: string
    readonly command: string
    readonly settled: Deferred.Deferred<Output>
    // Read at delivery; `false` admits the notice without waking the session.
    readonly resume?: () => false | undefined
  },
) {
  const info = (yield* jobs.wait({ id: input.id })).info
  if (!info || info.status === "running") return
  const output = info.status === "completed" ? yield* Deferred.await(input.settled) : undefined
  const text = output ? (info.output ?? "") : info.status === "error" ? (info.error ?? "Command failed") : "Cancelled"
  const resume = input.resume?.()
  yield* sessions.synthetic({
    ...(info.notificationID ? { id: info.notificationID } : {}),
    sessionID: input.sessionID,
    description: input.command,
    ...ShellResult.notification({
      jobID: input.id,
      shellID: input.shellID,
      command: input.command,
      state: info.status,
      text,
      output,
    }),
    ...(resume === false ? { resume } : {}),
  })
  if (info.notificationID) yield* jobs.completeBackground(info.notificationID)
})

// The job that waits on a command for its call (or its session, once backgrounded).
const startJob = Effect.fnUntraced(function* (
  jobs: Job.Interface,
  shell: Shell.Interface,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly info: ShellSchema.Info
    readonly notificationID?: SessionMessage.ID
    readonly timeout?: () => number
  },
) {
  const info = input.info
  const settled = yield* Deferred.make<Output>()
  const job = yield* jobs.start({
    // CodeMode children share a tool-call ID, but each shell must own its job.
    id: info.id,
    type: name,
    title: info.command,
    metadata: { sessionID: input.sessionID, shellID: info.id },
    recovery: {
      kind: "shell",
      sessionID: input.sessionID,
      shellID: info.id,
      command: info.command,
    },
    ...(input.notificationID ? { notificationID: input.notificationID } : {}),
    run: Effect.gen(function* () {
      const result = yield* shell.result(info)
      if (!result.capture) return yield* new Shell.NotFoundError({ id: info.id })
      return { ...ShellResult.output(result), status: "completed" as const }
    }).pipe(
      Effect.tap((output) => Deferred.succeed(settled, output)),
      Effect.map((output) => resultMessages(output, input.timeout?.()).join("\n\n")),
    ),
    // Only cancelling the job stops the command, keeping it and its output file. A server shutdown interrupts
    // the job without stopping it, so the command keeps running for the next server.
    cancel: shell.stop(info.id, "killed").pipe(Effect.ignore, Effect.asVoid),
  })
  return { job, settled }
})

/** The tool result of a call whose command moved to the background. */
export const backgroundToolResult = (shellID: string, file: string) => toolResult(backgroundResult(shellID, file))

/**
 * Watches a command taken over from a previous server as a background job of its session, and notifies the
 * session when it finishes, as for a command the model ran in the background. A finished command's notice is
 * admitted before this returns.
 */
export const reattach = Effect.fnUntraced(function* (input: {
  readonly shell: Shell.Interface
  readonly jobs: Job.Interface
  readonly sessions: Session.Interface
  readonly watch: Shell.DaemonInterface["watch"]
  readonly sessionID: SessionSchema.ID
  readonly info: ShellSchema.Info
  // The job's existing durable row, if the previous server had backgrounded it.
  readonly notificationID?: SessionMessage.ID
  readonly resume?: () => false | undefined
}) {
  const { job, settled } = yield* startJob(input.jobs, input.shell, input)
  yield* input.jobs.background(job.id)
  const notifying = notify(input.sessions, input.jobs, {
    sessionID: input.sessionID,
    id: job.id,
    shellID: input.info.id,
    command: input.info.command,
    settled,
    resume: input.resume,
  })
  const current = yield* input.shell.get(input.info.id).pipe(Effect.option)
  if (Option.isSome(current) && current.value.status !== "running")
    return yield* notifying.pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to report a recovered shell command", { id: input.info.id, error }),
      ),
    )
  yield* input.watch(notifying)
})

export const Plugin = {
  id: "opencode.tool.shell",
  effect: Effect.fn("ShellTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const environment = yield* Environment.Service
    const access = yield* FileAccess.Service
    const shell = yield* Shell.Service
    const daemon = yield* Shell.Daemon
    const shellSelect = yield* ShellSelect.Service
    const compatibleShell = shellSelect.resolve({ priority: "compat" })
    const permission = yield* Permission.Service

    const prepare = Effect.fn("ShellTool.prepare")(function* (invocation: ShellCreateBefore, context: Tool.Context) {
      const target = yield* access.resolve({ path: invocation.cwd, kind: "directory" })
      invocation.cwd = target.absolute
      const timeout = invocation.timeout
      const parsed = yield* ShellParse.scan(invocation.command, invocation.shell, target.absolute)
      const directories = yield* Effect.forEach(parsed.directories, (directory) =>
        access.resolve({
          path: FileAccess.resolvePath(target.absolute, directory),
          kind: "directory",
        }),
      )
      yield* access.authorizeExternal([target, ...directories], context)
      if (parsed.commands.length > 0)
        yield* permission.assert({
          action: name,
          resources: parsed.commands.map((command) => command.resource),
          save: parsed.commands.map((command) => command.save),
          ...Permission.invocation(context),
        })
      // Approval can outlive the directory, so validate immediately before spawning.
      const workdir = yield* Environment.typeFollowing(environment.files, target.absolute).pipe(
        Effect.catchTag("Environment.NotFound", () =>
          Effect.fail(new Error(`Working directory does not exist: ${target.absolute}`)),
        ),
      )
      if (workdir !== "directory")
        return yield* Effect.fail(new Error(`Working directory is not a directory: ${target.absolute}`))
      return timeout
    })

    // Not in this Location's scope: a daemon command outlives a Location that closes while the server runs, and
    // its session must still hear how it ended.
    const notifyWhenDone = (
      sessionID: SessionSchema.ID,
      id: string,
      shellID: string,
      command: string,
      settled: Deferred.Deferred<Output>,
    ) => daemon.watch(notify(sessions, jobs, { sessionID, id, shellID, command, settled }))

    // Handles an interrupted foreground call. When the user interrupted it, the command stops and the call
    // settles with the output so far. Anything else (a server shutdown) leaves the command and its job running:
    // the next server takes the call over and moves the command to the background.
    const interrupted = Effect.fnUntraced(function* (info: ShellSchema.Info, jobID: string) {
      const reason = yield* SessionInterruption.Reason
      if (reason() !== "user") return
      yield* shell.stop(info.id, "killed").pipe(Effect.ignore)
      // The stop escalates to SIGKILL on its own; the session does not wait for that to settle the call.
      const result = yield* shell.result(info, { wait: INTERRUPT_WAIT })
      // The stopped job settles from the same exit; this only releases it.
      yield* jobs.cancel(jobID)
      yield* ToolInterrupted.report(
        new ToolFailure({
          message: ShellResult.interrupted(result),
          metadata: { interrupted: true, truncated: result.capture?.truncated ?? false },
        }),
      )
    })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description: description(),
          input: Input,
          output: Output,
          execute: (input, context) => {
            const timeout = input.background === true ? (input.timeout ?? 0) : (input.timeout ?? DEFAULT_TIMEOUT_MS)
            let finalTimeout = timeout
            // Uninterruptible from spawning to blocking, so an interrupt cannot orphan a started command.
            return Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const info = yield* shell.create(
                  {
                    command: input.command,
                    cwd: input.workdir,
                    timeout,
                    shell: yield* compatibleShell,
                    metadata: { sessionID: context.sessionID },
                    waited: input.background !== true,
                    toolCall: {
                      sessionID: context.sessionID,
                      assistantMessageID: context.messageID,
                      callID: context.id,
                    },
                  },
                  (invocation) =>
                    Effect.gen(function* () {
                      invocation.env.AGENT = "1"
                      invocation.env.OPENCODE = "1"
                      invocation.env.AI_AGENT ||= "opencode"
                      invocation.env.OPENCODE_SESSION_ID = context.sessionID
                      finalTimeout = yield* restore(prepare(invocation, context))
                    }),
                )
                yield* context.progress({ shellID: info.id })

                const { job, settled } = yield* startJob(jobs, shell, {
                  sessionID: context.sessionID,
                  info,
                  timeout: () => finalTimeout,
                })

                if (input.background === true) {
                  yield* jobs.background(job.id)
                  yield* notifyWhenDone(context.sessionID, job.id, info.id, info.command, settled)
                  return backgroundResult(info.id, info.file)
                }

                const blocked = yield* restore(jobs.block({ id: job.id, sessionID: context.sessionID })).pipe(
                  Effect.exit,
                )
                if (Exit.isFailure(blocked)) {
                  if (Cause.hasInterrupts(blocked.cause)) yield* interrupted(info, job.id)
                  return yield* Effect.failCause(blocked.cause)
                }
                const result = blocked.value
                if (result?.type === "backgrounded") {
                  yield* shell.timeout(info.id, 0)
                  finalTimeout = 0
                  yield* notifyWhenDone(context.sessionID, job.id, info.id, info.command, settled)
                  return backgroundResult(info.id, info.file)
                }
                if (result?.info.status === "error")
                  return yield* Effect.fail(new Error(result.info.error ?? "Command failed"))
                if (result?.info.status === "cancelled") return yield* Effect.fail(new Error("Command cancelled"))

                return yield* Deferred.await(settled)
              }),
            ).pipe(
              // Shell spans, including the job that waits for a backgrounded command, name the call that started them.
              Effect.annotateSpans({
                "gen_ai.tool.call.id": context.id,
                ...(input.background === true ? { "opencode.shell.background": true } : {}),
              }),
              Effect.map((output) => toolResult(output, finalTimeout)),
              Effect.mapError(
                (error) => new ToolFailure({ message: `Unable to execute command: ${input.command}`, error }),
              ),
            )
          },
        }),
      )
      .pipe(Effect.orDie)

    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const tool = event.tools[name]
        if (!tool) return
        tool.description = description(ShellSelect.name(yield* compatibleShell))
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}
