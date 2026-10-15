import React, { KeyboardEvent, useEffect, useRef } from 'react';

type Props = {
    pending: boolean;
    onConfirm: () => void;
    onCancel: () => void;
};

/** Inline two-step delete confirmation (window.confirm is blocked in the sandboxed iframe). */
const DeleteConfirm: React.FC<Props> = ({ pending, onConfirm, onCancel }) => {
    const cancelRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        cancelRef.current?.focus();
    }, []);

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape' && !pending) {
            event.stopPropagation();
            onCancel();
        }
    };

    return (
        <div className="confirm-bar" role="group" aria-label="Confirm delete" onKeyDown={onKeyDown}>
            <span>Delete this task? This cannot be undone.</span>
            <span className="confirm-actions">
                <button
                    type="button"
                    className="danger-button"
                    onClick={onConfirm}
                    disabled={pending}
                >
                    {pending ? 'Deleting...' : 'Yes, delete'}
                </button>
                <button
                    ref={cancelRef}
                    type="button"
                    className="secondary-button"
                    onClick={onCancel}
                    disabled={pending}
                >
                    Cancel
                </button>
            </span>
        </div>
    );
};

export default DeleteConfirm;
