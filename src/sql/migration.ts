import { migrationRunner } from "@forge/sql";

export const CREATE_TODOS_TABLE = `CREATE TABLE IF NOT EXISTS Todos (
    todo_id BIGINT PRIMARY KEY AUTO_RANDOM,
    description VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'todo',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;

export const CREATE_AI_RUNS_TABLE = `CREATE TABLE IF NOT EXISTS AiRuns (
    run_id BIGINT PRIMARY KEY AUTO_RANDOM,
    todo_id BIGINT NOT NULL,
    content_version INT NOT NULL,
    status VARCHAR(30) NOT NULL,
    classification TEXT NULL,
    candidates TEXT NULL,
    recommended_model VARCHAR(100) NULL,
    confirmed_model VARCHAR(100) NULL,
    response MEDIUMTEXT NULL,
    prompt_tokens INT NULL,
    completion_tokens INT NULL,
    cost_usd DECIMAL(12,8) NULL,
    error_code VARCHAR(40) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    confirmed_at TIMESTAMP NULL,
    completed_at TIMESTAMP NULL,
    INDEX idx_airruns_todo (todo_id)
)`;

// Single-row-style cache of the OpenRouter model list (id is always 'openrouter').
export const CREATE_MODEL_CATALOG_CACHE_TABLE = `CREATE TABLE IF NOT EXISTS ModelCatalogCache (
    id VARCHAR(20) PRIMARY KEY,
    payload MEDIUMTEXT NOT NULL,
    fetched_at TIMESTAMP NOT NULL
)`;

// Append-only: never edit an existing migration. Forge runs one statement per enqueue.
export const MIGRATIONS: ReadonlyArray<readonly [name: string, statement: string]> = [
  ["v001_create_todos_table", CREATE_TODOS_TABLE],
  ["v002_todos_add_notes", "ALTER TABLE Todos ADD COLUMN notes TEXT NULL"],
  [
    "v003_todos_add_ai_state",
    "ALTER TABLE Todos ADD COLUMN ai_state VARCHAR(30) NOT NULL DEFAULT 'not_started'",
  ],
  [
    "v004_todos_add_content_version",
    "ALTER TABLE Todos ADD COLUMN content_version INT NOT NULL DEFAULT 1",
  ],
  [
    "v005_todos_add_updated_at",
    "ALTER TABLE Todos ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
  ],
  ["v006_create_ai_runs", CREATE_AI_RUNS_TABLE],
  ["v007_create_model_catalog_cache", CREATE_MODEL_CATALOG_CACHE_TABLE],
];

// enqueue() mutates and returns the shared runner, so it chains.
const migrations = MIGRATIONS.reduce(
  (runner, [name, statement]) => runner.enqueue(name, statement),
  migrationRunner,
);

export const runSchemaMigration = async () => {
  try {
    console.log("Running schema migrations");
    const successfulMigrations = await migrations.run();
    console.log("Migrations applied:", successfulMigrations);

    const migrationHistory = (await migrationRunner.list())
      .map((m) => `${m.id}, ${m.name}, ${m.migratedAt.toUTCString()}`)
      .join("\n");
    console.log(
      "Migrations history:\nid, name, migrated_at\n",
      migrationHistory,
    );

    return getHttpResponse(200, "Migrations successfully executed");
  } catch (e) {
    console.error("Error while executing migration", {
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
    });
    return getHttpResponse(500, "Error while executing migrations");
  }
};

/**
 * Builds the response shape expected by a webtrigger with `response.type: dynamic`.
 * Header values must be arrays of strings.
 */
function getHttpResponse(statusCode: number, body: string) {
  const statusTextByCode: Record<number, string> = {
    200: "OK",
    404: "Not Found",
    500: "Internal Server Error",
  };

  return {
    headers: { "Content-Type": ["application/json"] },
    statusCode,
    statusText: statusTextByCode[statusCode] ?? "Bad Request",
    body: JSON.stringify({ message: body }),
  };
}
