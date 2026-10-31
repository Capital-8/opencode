import { SqliteClient } from "@effect/sql-sqlite-node"
import { Layer } from "effect"
import type { SqlClient } from "effect/sql"

export const supportsTuningPragmas = true

// Foreign keys default OFF and can be toggled per connection.
export const supportsForeignKeyToggle = true

interface Config extends SqliteClient.SqliteClientConfig {
  /** Busy timeout in milliseconds, as `node:sqlite` names it. Prefer `busyTimeout`. */
  readonly timeout?: number
}

// Opening the database can only fail on a broken file or a lock held past
// busyTimeout; Database.layer treats both as fatal.
export const sqliteLayer = ({ timeout, ...config }: Config): Layer.Layer<SqlClient.SqlClient> =>
  Layer.orDie(SqliteClient.layer({ ...config, busyTimeout: config.busyTimeout ?? timeout }))
