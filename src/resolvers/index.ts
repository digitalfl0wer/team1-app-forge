import Resolver from '@forge/resolver';
import { sql, type UpdateQueryResponse } from '@forge/sql';

type Todo = {
  id: string;
  description: string;
  status: string;
  created_at: string;
};

const resolver = new Resolver();

resolver.define('getText', () => {
  return 'Hello, world!';
});

resolver.define('addTodo', async ({ payload }) => {
  const { description } = payload as { description: string };

  const result = await sql
    .prepare<UpdateQueryResponse>('INSERT INTO Todos (description) VALUES (?)')
    .bindParams(description)
    .execute();

  return { success: result.rows.affectedRows === 1 };
});

// todo_id is an AUTO_RANDOM BIGINT that can exceed JS's safe integer range, so it travels as a string.
resolver.define('getTodo', async ({ payload }) => {
  const { id } = payload as { id: string };

  const result = await sql
    .prepare<Todo>(
      `SELECT CAST(todo_id AS CHAR) AS id, description, status, created_at
       FROM Todos
       WHERE todo_id = CAST(? AS SIGNED)`
    )
    .bindParams(id)
    .execute();

  return result.rows[0] ?? null;
});

resolver.define('getTodos', async () => {
  const result = await sql
    .prepare<Todo>(
      `SELECT CAST(todo_id AS CHAR) AS id, description, status, created_at
       FROM Todos
       ORDER BY created_at DESC`
    )
    .execute();

  return result.rows;
});

export const handler = resolver.getDefinitions();
