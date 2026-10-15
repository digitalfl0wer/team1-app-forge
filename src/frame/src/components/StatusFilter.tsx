import React from 'react';
import { TODO_STATUSES, filterLabel, type StatusCounts, type StatusFilter as Filter } from '../todoView';

type Props = {
    value: Filter;
    counts: StatusCounts;
    onChange: (filter: Filter) => void;
};

const FILTERS: Filter[] = ['all', ...TODO_STATUSES];

const StatusFilter: React.FC<Props> = ({ value, counts, onChange }) => (
    <div className="filter-bar" role="group" aria-label="Filter by status">
        {FILTERS.map((filter) => (
            <button
                key={filter}
                type="button"
                className={`filter-button${value === filter ? ' filter-active' : ''}`}
                aria-pressed={value === filter}
                onClick={() => onChange(filter)}
            >
                {filterLabel(filter)} <span className="filter-count">{counts[filter]}</span>
            </button>
        ))}
    </div>
);

export default StatusFilter;
