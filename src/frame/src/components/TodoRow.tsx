import React, { useState } from 'react';
import { errorMessage } from '../api';
import { formatTimestamp, statusLabel, type Todo, type TodoStatus } from '../todoView';
import DeleteConfirm from './DeleteConfirm';
import TodoMenu from './TodoMenu';

type Props = {
    todo: Todo;
    readOnly: boolean;
    onOpen: (id: string, edit: boolean) => void;
    onSetStatus: (id: string, status: TodoStatus) => Promise<void>;
    onDelete: (id: string) => Promise<void>;
};

const TodoRow: React.FC<Props> = ({ todo, readOnly, onOpen, onSetStatus, onDelete }) => {
    const [pending, setPending] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState('');

    const run = async (action: () => Promise<void>) => {
        setPending(true);
        setError('');
        try {
            await action();
            setConfirming(false);
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setPending(false);
        }
    };

    return (
        <article className="todo-item">
            <div className="todo-content">
                <div className="todo-main">
                    <button
                        type="button"
                        className="todo-title"
                        data-todo-open={todo.id}
                        onClick={() => onOpen(todo.id, false)}
                    >
                        {todo.description}
                    </button>
                    <span className={`status status-${todo.status}`}>{statusLabel(todo.status)}</span>
                </div>

                <TodoMenu
                    taskLabel={todo.description}
                    status={todo.status}
                    writesDisabled={pending || readOnly}
                    onOpen={() => onOpen(todo.id, false)}
                    onEdit={() => onOpen(todo.id, true)}
                    onSetStatus={(status) => {
                        if (status !== todo.status) void run(() => onSetStatus(todo.id, status));
                    }}
                    onDelete={() => {
                        setError('');
                        setConfirming(true);
                    }}
                />
            </div>

            <small>Created {formatTimestamp(todo.created_at)}</small>

            {confirming && (
                <DeleteConfirm
                    pending={pending}
                    onConfirm={() => void run(() => onDelete(todo.id))}
                    onCancel={() => setConfirming(false)}
                />
            )}

            {error && (
                <p className="error-message" role="alert">
                    {error}
                </p>
            )}
        </article>
    );
};

export default TodoRow;
