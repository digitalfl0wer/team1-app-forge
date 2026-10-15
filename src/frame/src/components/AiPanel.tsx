import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api';
import { errorMessage } from '../api';
import type { AiCandidate, AiRun } from '../aiTypes';
import {
    ALL_CATEGORIES,
    capabilityList,
    categoryLabel,
    formatContext,
    formatRunTime,
    formatTokens,
    formatUsd,
    historySummary,
    isSelectableCategory,
    isStaleContent,
    modelName,
    needsPriceLinks,
    orderCandidates,
    runActions,
    runMessage,
    runStatusLabel,
    sourceLabel,
    tagLabel,
} from '../aiView';
import type { Todo } from '../todoView';
import PriceLinks from './PriceLinks';

type Props = {
    todo: Todo;
    /** Read-only Todo or database-updating state. */
    readOnly: boolean;
};

const STALE_NOTE = 'This answer was for an earlier version of the task.';

const CandidateInfo: React.FC<{ candidate: AiCandidate }> = ({ candidate }) => {
    const caps = capabilityList(candidate.capabilities);
    return (
        <dl className="ai-facts">
            <dt>Price</dt>
            <dd>{candidate.priceLabel}</dd>
            <dt>Estimated max cost</dt>
            <dd>
                {candidate.estimatedMaxCostUsd === null ? 'Unavailable' : formatUsd(candidate.estimatedMaxCostUsd)}
                <span className="field-hint"> (actual cost depends on usage)</span>
            </dd>
            <dt>Context length</dt>
            <dd>{formatContext(candidate.contextLength)}</dd>
            <dt>Capabilities</dt>
            <dd>{caps.length ? caps.join(', ') : 'Text only'}</dd>
            <dt>Metadata source</dt>
            <dd>{sourceLabel(candidate.metadataSource)}</dd>
        </dl>
    );
};

const ResponseText: React.FC<{ run: AiRun }> = ({ run }) => (
    <>
        <pre className="ai-response">{run.response ?? ''}</pre>
        <p className="field-hint">
            {modelName(run)}
            {run.usage
                ? ` - ${formatTokens(run.usage.promptTokens)} prompt tokens, ${formatTokens(
                      run.usage.completionTokens
                  )} completion tokens`
                : ''}
            {` - actual cost ${formatUsd(run.costUsd)}`}
        </p>
    </>
);

const AiPanel: React.FC<Props> = ({ todo, readOnly }) => {
    const [runs, setRuns] = useState<AiRun[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [historyError, setHistoryError] = useState('');
    const [pending, setPending] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [category, setCategory] = useState('general');
    const mounted = useRef(true);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const loadRuns = useCallback(async () => {
        try {
            const list = await api.getAiRuns(todo.id);
            if (!mounted.current) return;
            setRuns(list);
            setHistoryError('');
        } catch (err) {
            if (mounted.current) setHistoryError(errorMessage(err));
        } finally {
            if (mounted.current) setLoaded(true);
        }
    }, [todo.id]);

    useEffect(() => {
        void loadRuns();
    }, [loadRuns]);

    const mergeRun = (run: AiRun) =>
        setRuns((current) => [run, ...current.filter((r) => r.id !== run.id)].sort(byNewest));

    // Runs one AI call; a failure is shown inline and history is re-read so the real state shows.
    const act = async (key: string, call: () => Promise<AiRun>) => {
        if (pending !== null) return;
        setPending(key);
        setError('');
        try {
            mergeRun(await call());
        } catch (err) {
            if (mounted.current) {
                setError(errorMessage(err));
                void loadRuns();
            }
        } finally {
            if (mounted.current) setPending(null);
        }
    };

    const latest: AiRun | undefined = runs[0];
    const actions = latest ? runActions(latest.status) : null;
    const stale = latest ? isStaleContent(latest, todo) : false;
    const busy = pending !== null || (actions?.busy ?? false);
    const startDisabled = busy || readOnly;
    const confirmDisabled = busy || readOnly || stale;

    let liveText = '';
    if (pending === 'start') liveText = 'Checking your task and choosing a model...';
    else if (pending?.startsWith('confirm:')) liveText = 'Running the model. This can take up to 20 seconds...';
    else if (pending === 'category') liveText = 'Choosing a model...';
    else if (latest?.status === 'classifying') liveText = 'Classifying your task...';
    else if (latest?.status === 'running') liveText = 'A model run is in progress.';

    return (
        <section className="ai-panel" aria-labelledby="ai-heading">
            <h3 id="ai-heading">AI</h3>
            <p className="field-hint">
                Nothing is sent to AI until you click Start Task. The worker model runs only after you
                confirm it.
            </p>

            <div className="detail-actions">
                <button type="button" className="primary-button" disabled={startDisabled} onClick={() => void act('start', () => api.startTask(todo.id))}>
                    {pending === 'start' ? 'Starting...' : runs.length > 0 ? 'Start Task again' : 'Start Task'}
                </button>
            </div>
            {readOnly && <p className="field-hint">AI is unavailable while changes are paused.</p>}

            <div role="status" aria-live="polite" className="ai-live">
                {liveText}
            </div>

            {error && (
                <p className="error-message" role="alert">
                    {error}
                </p>
            )}

            {latest && actions && (
                <div className="ai-run" data-status={latest.status}>
                    <p>
                        <span className="status">{runStatusLabel(latest.status)}</span>
                        {latest.category && <> Category: {categoryLabel(latest.category)}</>}
                    </p>

                    {stale && latest.status !== 'succeeded' && (
                        <p className="field-hint">
                            {STALE_NOTE} Start Task again to get a fresh recommendation.
                        </p>
                    )}

                    {actions.canConfirm && (
                        <Recommendation
                            run={latest}
                            disabled={confirmDisabled}
                            pending={pending}
                            onConfirm={(modelId) => void act(`confirm:${modelId}`, () => api.confirmRun(latest.id, modelId))}
                        />
                    )}

                    {actions.canChooseCategory && (
                        <div className="ai-clarify">
                            <p>We could not tell what kind of task this is.</p>
                            <label htmlFor="ai-category">Choose a category</label>
                            <select id="ai-category" value={category} disabled={busy || readOnly || stale} onChange={(e) => setCategory(e.target.value)}>
                                {ALL_CATEGORIES.map((c) => (
                                    <option key={c} value={c} disabled={!isSelectableCategory(c)}>
                                        {categoryLabel(c)}
                                        {isSelectableCategory(c) ? '' : ' (V2: not enabled)'}
                                    </option>
                                ))}
                            </select>{' '}
                            <button
                                type="button"
                                className="secondary-button"
                                disabled={busy || readOnly || stale || !isSelectableCategory(category)}
                                onClick={() => void act('category', () => api.chooseCategory(latest.id, category))}
                            >
                                Use this category
                            </button>
                        </div>
                    )}

                    {(latest.status === 'blocked_by_guard' ||
                        latest.status === 'no_eligible_model' ||
                        latest.status === 'failed' ||
                        latest.status === 'stale') && (
                        <div>
                            <p>{runMessage(latest)}</p>
                            <p className="field-hint">Your task was not changed. You can try again.</p>
                        </div>
                    )}

                    {actions.busy && (
                        <p className="field-hint">
                            This run is {latest.status === 'running' ? 'running' : 'classifying'}. If it does
                            not finish, reload the task in a couple of minutes.
                        </p>
                    )}

                    {actions.showResponse && (
                        <>
                            {stale && <p className="field-hint">{STALE_NOTE}</p>}
                            <ResponseText run={latest} />
                        </>
                    )}
                </div>
            )}

            <h4>Run history</h4>
            {!loaded ? (
                <p className="field-hint">Loading history...</p>
            ) : historyError ? (
                <p className="error-message" role="alert">
                    {historyError}{' '}
                    <button type="button" className="secondary-button" onClick={() => void loadRuns()}>
                        Retry
                    </button>
                </p>
            ) : runs.length === 0 ? (
                <p className="field-hint">No AI runs yet.</p>
            ) : (
                <ul className="ai-history">
                    {runs.map((run) => (
                        <li key={run.id}>
                            <details>
                                <summary>
                                    {historySummary(run)}
                                    <span className="field-hint"> - {formatRunTime(run.createdAt)}</span>
                                </summary>
                                {isStaleContent(run, todo) && <p className="field-hint">{STALE_NOTE}</p>}
                                {run.status === 'succeeded' ? (
                                    <ResponseText run={run} />
                                ) : (
                                    <p>{runMessage(run) || runStatusLabel(run.status)}</p>
                                )}
                            </details>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
};

const byNewest = (a: AiRun, b: AiRun) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);

const Recommendation: React.FC<{
    run: AiRun;
    disabled: boolean;
    pending: string | null;
    onConfirm: (modelId: string) => void;
}> = ({ run, disabled, pending, onConfirm }) => {
    const ordered = orderCandidates(run);
    const recommended = ordered.find((x) => x.tag === 'recommended');
    const others = ordered.filter((x) => x.tag !== 'recommended');

    if (!recommended) return <p>No model could be recommended. Try again.</p>;
    const { candidate } = recommended;

    return (
        <div className="ai-recommendation">
            <h4>Recommendation</h4>
            <p>
                Category: <strong>{categoryLabel(run.category)}</strong>
            </p>
            <div className="ai-card ai-card-recommended">
                <h5>
                    {candidate.displayName} <span className="status">{tagLabel('recommended')}</span>
                </h5>
                <p className="field-hint">{candidate.modelId}</p>
                {(candidate.reason || run.reason) && <p>{candidate.reason || run.reason}</p>}
                <CandidateInfo candidate={candidate} />
                {needsPriceLinks(candidate) && (
                    <PriceLinks modelName={candidate.displayName} modelUrl={candidate.pricingUrl || run.pricingUrls.recommendedModel} />
                )}
                <button
                    type="button"
                    className="primary-button"
                    disabled={disabled}
                    onClick={() => onConfirm(candidate.modelId)}
                >
                    {pending === `confirm:${candidate.modelId}` ? 'Running...' : `Run with ${candidate.displayName}`}
                </button>
            </div>

            {others.length > 0 && (
                <>
                    <h5>Other options</h5>
                    <ul className="ai-candidates">
                        {others.map(({ candidate: c, tag }) => (
                            <li key={c.modelId} className={`ai-card${tag !== 'other' ? ' ai-card-highlight' : ''}`}>
                                <strong>{c.displayName}</strong>{' '}
                                {tag !== 'other' && <span className="status">{tagLabel(tag)}</span>}
                                <p className="field-hint">{c.modelId}</p>
                                {c.reason && <p>{c.reason}</p>}
                                <CandidateInfo candidate={c} />
                                {needsPriceLinks(c) && <PriceLinks modelName={c.displayName} modelUrl={c.pricingUrl} />}
                                <button
                                    type="button"
                                    className="secondary-button"
                                    disabled={disabled}
                                    onClick={() => onConfirm(c.modelId)}
                                >
                                    {pending === `confirm:${c.modelId}` ? 'Running...' : `Run with ${c.displayName}`}
                                </button>
                            </li>
                        ))}
                    </ul>
                </>
            )}
            <p className="field-hint">Nothing runs until you click a Run button.</p>
        </div>
    );
};

export default AiPanel;
