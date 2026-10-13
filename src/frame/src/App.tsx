import React, {
    FormEvent,
    useCallback,
    useEffect,
    useState,
} from 'react';

import { invoke, view } from '@forge/bridge';
import './App.css';

type Todo = {
    id: string;
    description: string;
    status: string;
    created_at: string;
};

const App: React.FC = () => {
    const [todos, setTodos] = useState<Todo[]>([]);
    const [description, setDescription] = useState('');
    const [loading, setLoading] = useState(true);
    const [adding, setAdding] = useState(false);
    const [error, setError] = useState('');

    // invoke crosses the Frame boundary to Alan's backend; SQL stays on Forge.
    const loadTodos = useCallback(async () => {
        try {
            setLoading(true);
            setError('');

            const result = await invoke<Todo[]>('getTodos');
            // Bridge types also allow responses with metadata. These resolvers
            // return plain data, so check that shape before updating React state.
            if (!Array.isArray(result)) {
                throw new Error('Unexpected Todo list response.');
            }
            setTodos(result);
        } catch (err) {
            console.error(err);
            setError('Could not load todos.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        // Jira supplies live light/dark design tokens; CSS also has fallbacks.
        void view.theme.enable().catch((err) => console.error('Could not enable Jira theme', err));
        void loadTodos();
    }, [loadTodos]);

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault();

        const trimmedDescription = description.trim();

        if (adding || loading || !trimmedDescription || trimmedDescription.length > 255) {
            return;
        }

        try {
            setAdding(true);
            setError('');

            const result = await invoke<{ success: boolean }>('addTodo', {
                description: trimmedDescription,
            });

            if (!result || !('success' in result) || !result.success) {
                throw new Error('Todo was not created.');
            }

            setDescription('');
            await loadTodos();
        } catch (err) {
            console.error(err);
            setError('Could not add todo.');
        } finally {
            setAdding(false);
        }
    };

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
                    onClick={() => void loadTodos()}
                    disabled={loading || adding}
                >
                    Refresh
                </button>
            </header>

            <label htmlFor="todo-description">Todo description</label>
            <form className="add-todo" onSubmit={handleSubmit}>
                <input
                    id="todo-description"
                    disabled={adding}
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
                    disabled={adding || loading || !description.trim()}
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
                    <span>{todos.length} total</span>
                </div>

                {loading ? (
                    <p>Loading todos...</p>
                ) : error && todos.length === 0 ? (
                    <p>Use Refresh to try loading your todos again.</p>
                ) : todos.length === 0 ? (
                    <div className="empty-state">
                        <h3>No todos yet</h3>
                        <p>Add your first task above.</p>
                    </div>
                ) : (
                    <div className="todo-list">
                        {todos.map((todo) => (
                            <article className="todo-item" key={todo.id}>
                                <div className="todo-content">
                                    <p>{todo.description}</p>

                                    <span className={`status status-${todo.status}`}>
                    {todo.status}
                  </span>
                                </div>

                                <small>
                                    Created {new Date(todo.created_at).toLocaleString()}
                                </small>
                            </article>
                        ))}
                    </div>
                )}
            </section>
        </main>
    );
};

export default App;
