import React, { KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { STATUS_LABELS, TODO_STATUSES, type TodoStatus } from '../todoView';

type Props = {
    taskLabel: string;
    status: TodoStatus;
    /** Disables every menu action except Open (pending write or read-only mode). */
    writesDisabled: boolean;
    onOpen: () => void;
    onEdit: () => void;
    onSetStatus: (status: TodoStatus) => void;
    onDelete: () => void;
};

type Item = {
    key: string;
    label: string;
    role: 'menuitem' | 'menuitemradio';
    checked?: boolean;
    disabled?: boolean;
    danger?: boolean;
    run: () => void;
};

const TodoMenu: React.FC<Props> = ({
    taskLabel,
    status,
    writesDisabled,
    onOpen,
    onEdit,
    onSetStatus,
    onDelete,
}) => {
    const [open, setOpen] = useState(false);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const menuId = useId();

    const close = useCallback((returnFocus: boolean) => {
        setOpen(false);
        if (returnFocus) triggerRef.current?.focus();
    }, []);

    const focusables = (): HTMLButtonElement[] =>
        Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);

    useEffect(() => {
        if (open) focusables()[0]?.focus();
    }, [open]);

    useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event: MouseEvent) => {
            if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', onPointerDown);
        return () => document.removeEventListener('mousedown', onPointerDown);
    }, [open]);

    const items: Item[] = [
        { key: 'open', label: 'Open', role: 'menuitem', run: onOpen },
        { key: 'edit', label: 'Edit', role: 'menuitem', disabled: writesDisabled, run: onEdit },
    ];
    const statusItems: Item[] = TODO_STATUSES.map((value) => ({
        key: `status-${value}`,
        label: STATUS_LABELS[value],
        role: 'menuitemradio',
        checked: value === status,
        disabled: writesDisabled,
        run: () => onSetStatus(value),
    }));
    const deleteItem: Item = {
        key: 'delete',
        label: 'Delete',
        role: 'menuitem',
        disabled: writesDisabled,
        danger: true,
        run: onDelete,
    };

    const renderItem = (item: Item) => (
        <button
            key={item.key}
            type="button"
            role={item.role}
            aria-checked={item.role === 'menuitemradio' ? item.checked : undefined}
            className={`menu-item${item.danger ? ' menu-item-danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
                close(true);
                item.run();
            }}
        >
            {item.role === 'menuitemradio' && (
                <span className="menu-check" aria-hidden="true">
                    {item.checked ? '✓' : ''}
                </span>
            )}
            {item.label}
        </button>
    );

    const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const buttons = focusables();
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close(true);
        } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            buttons[(index + 1) % buttons.length]?.focus();
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            buttons[(index - 1 + buttons.length) % buttons.length]?.focus();
        } else if (event.key === 'Home') {
            event.preventDefault();
            buttons[0]?.focus();
        } else if (event.key === 'End') {
            event.preventDefault();
            buttons[buttons.length - 1]?.focus();
        } else if (event.key === 'Tab') {
            setOpen(false);
        }
    };

    return (
        <div className="menu-wrapper" ref={wrapperRef}>
            <button
                ref={triggerRef}
                type="button"
                className="secondary-button menu-trigger"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={open ? menuId : undefined}
                aria-label={`Actions for ${taskLabel}`}
                onClick={() => setOpen((value) => !value)}
                onKeyDown={(event) => {
                    if (event.key === 'ArrowDown' && !open) {
                        event.preventDefault();
                        setOpen(true);
                    }
                }}
            >
                <span aria-hidden="true">{'⋯'}</span>
            </button>

            {open && (
                <div
                    id={menuId}
                    ref={menuRef}
                    className="menu"
                    role="menu"
                    aria-label={`Actions for ${taskLabel}`}
                    onKeyDown={onMenuKeyDown}
                >
                    {items.map(renderItem)}
                    <div className="menu-heading" role="presentation">
                        Change status
                    </div>
                    {statusItems.map(renderItem)}
                    <div className="menu-separator" role="separator" />
                    {renderItem(deleteItem)}
                </div>
            )}
        </div>
    );
};

export default TodoMenu;
