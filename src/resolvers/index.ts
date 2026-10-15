import Resolver from '@forge/resolver';
import { chooseCategory, confirmRun, getAiRuns, getModels, refreshModels, startTask } from './ai';
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
resolver.define('startTask', ({ payload }) => startTask(payload));
resolver.define('chooseCategory', ({ payload }) => chooseCategory(payload));
resolver.define('confirmRun', ({ payload }) => confirmRun(payload));
resolver.define('getAiRuns', ({ payload }) => getAiRuns(payload));
resolver.define('getModels', () => getModels());
resolver.define('refreshModels', () => refreshModels());

export const handler = resolver.getDefinitions();
