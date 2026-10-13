import { migrationRunner } from "@forge/sql";

export const CREATE_TODOS_TABLE = `CREATE TABLE IF NOT EXISTS Todos (
    todo_id BIGINT PRIMARY KEY AUTO_RANDOM,
    description VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'todo',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;

const migrations = migrationRunner.enqueue(
  "v001_create_todos_table",
  CREATE_TODOS_TABLE,
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
      message: e?.message,
      stack: e?.stack,
    });
    return getHttpResponse(500, "Error while executing migrations");
  }
};

/**
 * Builds the response shape expected by a webtrigger with `response.type: dynamic`.
 * Header values must be arrays of strings.
 */
function getHttpResponse(statusCode, body) {
  const statusTextByCode = {
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
