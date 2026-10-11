import { migrationRunner } from '@forge/sql';

//// Start of definition for schema migration statements ////
// The SQL statements should be idempotent.
export const CREATE_TODOS_TABLE = `CREATE TABLE IF NOT EXISTS Todos (
    todo_id BIGINT PRIMARY KEY AUTO_RANDOM,
    description VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'todo',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;

//// End of definition for schema migration statements ////

// Add the migrations to the queue, so they will be run in the order they are enqueued.
// Give each migration an unique version+name. Once a migration is run, it will be recorded in the database.
// If the migration is already run, it will be skipped.
const migrations = migrationRunner
  .enqueue('v001_create_todos_table', CREATE_TODOS_TABLE);

// The function to run the migrations in response to Forge events and triggers.
export const runSchemaMigration = async () => {
  try {
    console.log('Running schema migrations');
    const successfulMigrations = await migrations.run();
    console.log('Migrations applied:', successfulMigrations);

    const migrationHistory = (await migrationRunner.list())
      .map((y) => `${y.id}, ${y.name}, ${y.migratedAt.toUTCString()}`)
      .join('\n');
    console.log('Migrations history:\nid, name, migrated_at\n', migrationHistory);

    return getHttpResponse(200, 'Migrations successfully executed');
  } catch (e) {
    console.error('Error while executing migration', { error: JSON.stringify(e)});
    return getHttpResponse(500, 'Error while executing migrations');
  }
};

function getHttpResponse<Body>(statusCode: number, body: Body) {
  let statusText = '';
  if (statusCode === 200) {
    statusText = 'Ok';
  } else if (statusCode === 404) {
    statusText = 'Not Found';
  } else {
    statusText = 'Bad Request';
  }

  return {
    headers: { 'Content-Type': ['application/json'] },
    statusCode,
    statusText,
    body,
  };
}
