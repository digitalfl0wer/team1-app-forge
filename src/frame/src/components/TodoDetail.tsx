import React, { ReactNode, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../api';
import {
    DESCRIPTION_MAX,
    NOTES_MAX,
    STATUS_LABELS,
    TODO_STATUSES,
    draftFromTodo,
    draftToUpdate,
    formatTimestamp,
    isDraftChanged,
    isDraftValid,
    isTodoStatus,
    remainingHint,
    statusLabel,
    validateDraft,
    type Todo,
    type TodoStatus,
} from '../todoView';
import DeleteConfirm from './DeleteConfirm';

type Props = {
    todo: Todo;
    readOnly: boolean;
    startEditing: boolean;
    onBack: () => void;
    onSetStatus: (id: string, status: TodoStatus) => Promise<void>;
    onSave: (id: string, fields: { description?: string; notes?: string }) => Promise<void>;
    onDelete: (id: string) => Promise<void>;
    /** Extra sections (for example AI) render below the task details. */
    children?: ReactNode;
};

const TodoDetail: React.FC<Props> = ({
    todo,
    readOnly,
    startEditing,
    onBack,
    onSetStatus,
    onSave,
    onDelete,
    children,
}) => {
    const [editing, setEditing] = useState(startEditing && !readOnly);
    const [draft, setDraft] = useState(() => draftFromTodo(todo));
    const [pending, setPending] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState('');
    const headingRef = useRef<HTMLHeadingElement>(null);
    const descriptionRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (editing) descriptionRef.current?.focus();
        else headingRef.current?.focus();
        // Only on entering/leaving edit mode.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editing]);

    const run = async (action: () => Promise<void>): Promise<boolean> => {
        setPending(true);
        setError('');
        try {
            await action();
            return true;
        } catch (err) {
            setError(errorMessage(err));
            return false;
        } finally {
            setPending(false);
        }
    };

    const errors = validateDraft(draft);
    const locked = pending || readOnly;

    const startEdit = () => {
        setDraft(draftFromTodo(todo));
        setError('');
        setConfirming(false);
        setEditing(true);
    };

    const save = async () => {
        if (!isDraftValid(draft) || locked) return;
        if (!isDraftChanged(todo, draft)) {
            setEditing(false);
            return;
        }
        const ok = await run(() => onSave(todo.id, draftToUpdate(todo, draft)));
        if (ok) setEditing(false);
    };

    return (
        <section
            className="todo-detail"
            aria-label="Task details"
            onKeyDown={(event) => {
                if (event.key === 'Escape' && editing && !pending) setEditing(false);
            }}
        >
            <button type="button" className="secondary-button back-button" onClick={onBack} disabled={pending}>
                {'←'} Back to list
            </button>

            {editing ? (
                <form
                    className="detail-form"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void save();
                    }}
                >
                    <h2 ref={headingRef} tabIndex={-1}>
                        Edit task
                    </h2>

                    <label htmlFor="detail-description">Task</label>
                    <input
                        id="detail-description"
                        ref={descriptionRef}
                        type="text"
                        value={draft.description}
                        disabled={locked}
                        aria-invalid={errors.description !== null}
                        aria-describedby="detail-description-hint"
                        onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                    />
                    <small
                        id="detail-description-hint"
                        className={errors.description ? 'field-error' : 'field-hint'}
                    >
                        {errors.description ?? remainingHint(draft.description.trim(), DESCRIPTION_MAX)}
                    </small>

                    <label htmlFor="detail-notes">Notes</label>
                    <textarea
                        id="detail-notes"
                        rows={6}
                        value={draft.notes}
                        disabled={locked}
                        aria-invalid={errors.notes !== null}
                        aria-describedby="detail-notes-hint"
                        onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
                    />
                    <small id="detail-notes-hint" className={errors.notes ? 'field-error' : 'field-hint'}>
                        {errors.notes ?? remainingHint(draft.notes, NOTES_MAX)}
                    </small>

                    <div className="detail-actions">
                        <button
                            type="submit"
                            className="primary-button"
                            disabled={locked || !isDraftValid(draft) || !isDraftChanged(todo, draft)}
                        >
                            {pending ? 'Saving...' : 'Save'}
                        </button>
                        <button
                            type="button"
                            className="secondary-button"
                            disabled={pending}
                            onClick={() => {
                                setEditing(false);
                                setError('');
                            }}
                        >
                            Cancel
                        </button>
                    </div>
                </form>
            ) : (
                <>
                    <h2 ref={headingRef} tabIndex={-1} className="detail-title">
                        {todo.description}
                    </h2>

                    <h3>Notes</h3>
                    {todo.notes ? (
                        <p className="detail-notes">{todo.notes}</p>
                    ) : (
                        <p className="field-hint">No notes yet.</p>
                    )}

                    <div className="detail-status">
                        <label htmlFor="detail-status">Status</label>
                        <select
                            id="detail-status"
                            value={todo.status}
                            disabled={locked}
                            onChange={(event) => {
                                const next = event.target.value;
                                if (isTodoStatus(next) && next !== todo.status) {
                                    void run(() => onSetStatus(todo.id, next));
                                }
                            }}
                        >
                            {TODO_STATUSES.map((value) => (
                                <option key={value} value={value}>
                                    {STATUS_LABELS[value]}
                                </option>
                            ))}
                            {!isTodoStatus(todo.status) && (
                                <option value={todo.status}>{statusLabel(todo.status)}</option>
                            )}
                        </select>
                    </div>

                    <p className="detail-times">
                        Created {formatTimestamp(todo.created_at)}
                        <br />
                        Updated {formatTimestamp(todo.updated_at)}
                    </p>

                    <div className="detail-actions">
                        <button type="button" className="secondary-button" onClick={startEdit} disabled={locked}>
                            Edit
                        </button>
                        <button
                            type="button"
                            className="danger-outline-button"
                            onClick={() => {
                                setError('');
                                setConfirming(true);
                            }}
                            disabled={locked || confirming}
                        >
                            Delete
                        </button>
                    </div>

                    {confirming && (
                        <DeleteConfirm
                            pending={pending}
                            onConfirm={() => void run(() => onDelete(todo.id))}
                            onCancel={() => setConfirming(false)}
                        />
                    )}
                </>
            )}

            {error && (
                <p className="error-message" role="alert">
                    {error}
                </p>
            )}

            <div className="detail-extra">{children}</div>
        </section>
    );
};

export default TodoDetail;
