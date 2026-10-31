// Bundled for Node by sqlite-node.test.ts and run with `node <dir>`, so #sqlite
// resolves to the node:sqlite client that the standalone Node build ships.
import { join } from "node:path"
import { Global } from "@opencode/util/global"
import { sql } from "drizzle-orm"
import { Cause, Effect, Layer } from "effect"
import { isSqlError } from "effect/sql/SqlError"
import { Database } from "../../src/database/database"

const dir = process.argv[2]!

const program = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const journal = yield* db.get<{ journal_mode: string }>(sql`PRAGMA journal_mode`)
  yield* db.run(sql`CREATE TABLE probe (id TEXT PRIMARY KEY)`)
  yield* db.transaction((tx) =>
    Effect.all([tx.run(sql`INSERT INTO probe (id) VALUES ('a')`), tx.run(sql`INSERT INTO probe (id) VALUES ('b')`)]),
  )
  const error = yield* db.run(sql`INSERT INTO probe (id) VALUES ('a')`).pipe(Effect.flip)
  const cause = Cause.isCause(error.cause) ? Cause.squash(error.cause) : error.cause
  const rows = yield* db.all<{ count: number }>(sql`SELECT count(*) AS count FROM probe`)
  return {
    journal: journal?.journal_mode,
    reason: isSqlError(cause) ? cause.reason._tag : "not a SqlError",
    rows: rows[0]?.count,
  }
})

const global = Global.layerWith({
  data: dir,
  cache: dir,
  config: dir,
  state: dir,
  tmp: dir,
  bin: dir,
  log: dir,
  repos: dir,
})

const database = Database.layer({ path: join(dir, "opencode.db") }).pipe(Layer.provide(global))
console.log(JSON.stringify(await Effect.runPromise(program.pipe(Effect.provide(database)))))
