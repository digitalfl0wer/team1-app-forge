import React, {
    FormEvent,
    useCallback,
    useEffect,
    useRef,
    useState,
} from 'react';

import { view } from '@forge/bridge';
import * as api from './api';
import { errorMessage, isDatabaseUpdating } from './api';
import StatusFilter from './components/StatusFilter';
import TodoDetail from './components/TodoDetail';
import TodoRow from './components/TodoRow';
import {
    countByStatus,
    filterLabel,
    filterTodos,
    removeTodo,
    replaceTodo,
    validateDescription,
    type StatusFilter as Filter,
    type Todo,
    type TodoStatus,
} from './todoView';
import './App.css';

const App: React.FC = () => {
    const [todos, setTodos] = useState<Todo[]>([]);
    const [description, setDescription] = useState('');
    const [loading, setLoading] = useState(true);
    const [adding, setAdding] = useState(false);
    const [error, setError] = useState('');
    const [filter, setFilter] = useState<Filter>('all');
    const [selected, setSelected] = useState<{ id: string; edit: boolean } | null>(null);
    // Set when the backend says the database is still updating: writes stay disabled, reads keep working.
    const [readOnly, setReadOnly] = useState(false);
    const lastOpenedId = useRef<string | null>(null);

    // invoke crosses the Frame boundary to Alan's backend; SQL stays on Forge.
    // `silent` reloads after writes without swapping the list for a loading message.
    const loadTodos = useCallback(async (silent = false) => {
        try {
            if (!silent) setLoading(true);
            setError('');

            // api.getTodos validates the response shape before it reaches React state.
            setTodos(await api.getTodos());
        } catch (err) {
            console.error(err);
            setError(silent ? 'Saved, but the list could not be refreshed. Use Refresh.' : errorMessage(err));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        // Jira supplies live light/dark design tokens; CSS also has fallbacks.
        void view.theme.enable().catch((err) => console.error('Could not enable Jira theme', err));
        void loadTodos();
    }, [loadTodos]);

    const noteWriteFailure = (err: unknown) => {
        if (isDatabaseUpdating(err) && /updating/i.test(errorMessage(err))) setReadOnly(true);
    };

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault();

        const trimmedDescription = description.trim();

        if (adding || loading || readOnly || validateDescription(description) !== null) {
            return;
        }

        try {
            setAdding(true);
            setError('');

            await api.addTodo(trimmedDescription);

            setDescription('');
            await loadTodos(true);
        } catch (err) {
            noteWriteFailure(err);
            setError(errorMessage(err));
        } finally {
            setAdding(false);
        }
    };

    // Row and detail actions: update local state from the response, reload, rethrow failures
    // so the calling component shows the message inline next to the control that failed.
    const afterWrite = async (apply: () => void) => {
        apply();
        await loadTodos(true);
    };

    const handleSetStatus = async (id: string, status: TodoStatus) => {
        try {
            const todo = await api.setTodoStatus(id, status);
            await afterWrite(() => setTodos((current) => replaceTodo(current, todo)));
        } catch (err) {
            noteWriteFailure(err);
            throw err;
        }
    };

    const handleSave = async (id: string, fields: { description?: string; notes?: string }) => {
        try {
            const todo = await api.updateTodo(id, fields);
            await afterWrite(() => setTodos((current) => replaceTodo(current, todo)));
        } catch (err) {
            noteWriteFailure(err);
            throw err;
        }
    };

    const handleDelete = async (id: string) => {
        try {
            await api.deleteTodo(id);
            setSelected(null);
            await afterWrite(() => setTodos((current) => removeTodo(current, id)));
        } catch (err) {
            noteWriteFailure(err);
            throw err;
        }
    };

    const openTodo = (id: string, edit: boolean) => {
        lastOpenedId.current = id;
        setSelected({ id, edit });
    };

    const closeDetail = () => setSelected(null);

    // Return focus to the task that was open when going back to the list.
    useEffect(() => {
        if (selected === null && lastOpenedId.current !== null) {
            const id = lastOpenedId.current;
            lastOpenedId.current = null;
            const buttons = document.querySelectorAll<HTMLElement>('[data-todo-open]');
            for (let i = 0; i < buttons.length; i += 1) {
                if (buttons[i].getAttribute('data-todo-open') === id) {
                    buttons[i].focus();
                    break;
                }
            }
        }
    }, [selected]);

    const counts = countByStatus(todos);
    const visibleTodos = filterTodos(todos, filter);
    const selectedTodo = selected ? todos.find((todo) => todo.id === selected.id) ?? null : null;

    return (
        <main className="todo-app">
            <header className="todo-header">
                <div>
                    <h1>Team 1 Todo List</h1>
                    <p>Keep track of what needs to get done.</p>
                </div>

                <button
                    className="secondary-button"
                    type="button"
                    onClick={() => {
                        setReadOnly(false);
                        void loadTodos();
                    }}
                    disabled={loading || adding}
                >
                    Refresh
                </button>
            </header>

            {readOnly && (
                <p className="error-message" role="status">
                    Changes are paused while the app updates its database. You can still read your
                    todos. Use Refresh to try again.
                </p>
            )}

            {selected ? (
                <>
                    {error && (
                        <p className="error-message" role="alert">
                            {error}
                        </p>
                    )}
                    {selectedTodo ? (
                        <TodoDetail
                            key={selectedTodo.id}
                            todo={selectedTodo}
                            readOnly={readOnly}
                            startEditing={selected.edit}
                            onBack={closeDetail}
                            onSetStatus={handleSetStatus}
                            onSave={handleSave}
                            onDelete={handleDelete}
                        />
                    ) : loading ? (
                        <p>Loading todo...</p>
                    ) : (
                        <div className="empty-state">
                            <h3>Todo not found</h3>
                            <p>It may have been deleted.</p>
                            <button type="button" className="secondary-button" onClick={closeDetail}>
                                Back to list
                            </button>
                        </div>
                    )}
                </>
            ) : (
                <>
                    <label htmlFor="todo-description">Todo description</label>
                    <form className="add-todo" onSubmit={handleSubmit}>
                        <input
                            id="todo-description"
                            disabled={adding || readOnly}
                            required
                            type="text"
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                            placeholder="What needs to be done?"
                            maxLength={255}
                        />

                        <button
                            className="primary-button"
                            type="submit"
                            disabled={adding || loading || readOnly || !description.trim()}
                        >
                            {adding ? 'Adding...' : 'Add Todo'}
                        </button>
                    </form>

                    {error && (
                        <p className="error-message" role="alert">
                            {error}
                        </p>
                    )}

                    <section className="todo-section" aria-busy={loading} aria-live="polite">
                        <div className="section-heading">
                            <h2>Todos</h2>
                            <span>{counts.all} total</span>
                        </div>

                        <StatusFilter value={filter} counts={counts} onChange={setFilter} />

                        {loading ? (
                            <p>Loading todos...</p>
                        ) : error && todos.length === 0 ? (
                            <p>Use Refresh to try loading your todos again.</p>
                        ) : todos.length === 0 ? (
                            <div className="empty-state">
                                <h3>No todos yet</h3>
                                <p>Add your first task above.</p>
                            </div>
                        ) : visibleTodos.length === 0 ? (
                            <div className="empty-state">
                                <h3>Nothing in {filterLabel(filter)}</h3>
                                <p>Choose another filter to see more tasks.</p>
                            </div>
                        ) : (
                            <div className="todo-list">
                                {visibleTodos.map((todo) => (
                                    <TodoRow
                                        key={todo.id}
                                        todo={todo}
                                        readOnly={readOnly}
                                        onOpen={openTodo}
                                        onSetStatus={handleSetStatus}
                                        onDelete={handleDelete}
                                    />
                                ))}
                            </div>
                        )}
                    </section>
                </>
            )}
        </main>
    );
};

export default App;
