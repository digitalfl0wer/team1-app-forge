import Resolver from '@forge/resolver';
import { addTodo, deleteTodo, getTodo, getTodos, setTodoStatus, updateTodo } from './todos';

const resolver = new Resolver();

resolver.define('getText', () => {
  return 'Hello, world!';
});

resolver.define('addTodo', ({ payload }) => addTodo(payload));
resolver.define('getTodo', ({ payload }) => getTodo(payload));
resolver.define('getTodos', () => getTodos());
resolver.define('updateTodo', ({ payload }) => updateTodo(payload));
resolver.define('setTodoStatus', ({ payload }) => setTodoStatus(payload));
resolver.define('deleteTodo', ({ payload }) => deleteTodo(payload));

export const handler = resolver.getDefinitions();
