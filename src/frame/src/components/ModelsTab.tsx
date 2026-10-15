import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api';
import { errorMessage } from '../api';
import type { ModelsResult } from '../aiTypes';
import { formatContext, formatRunTime, listOrDash, sourceLabel } from '../aiView';

const ModelsTab: React.FC = () => {
    const [data, setData] = useState<ModelsResult | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState('');
    const mounted = useRef(true);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const run = useCallback(async (load: () => Promise<ModelsResult>, refresh: boolean) => {
        if (refresh) setRefreshing(true);
        else setLoading(true);
        setError('');
        try {
            const result = await load();
            if (mounted.current) setData(result);
        } catch (err) {
            if (mounted.current) setError(errorMessage(err));
        } finally {
            if (mounted.current) {
                setLoading(false);
                setRefreshing(false);
            }
        }
    }, []);

    useEffect(() => {
        void run(api.getModels, false);
    }, [run]);

    return (
        <section aria-labelledby="models-heading" className="models-tab">
            <div className="section-heading">
                <h2 id="models-heading">Models</h2>
                <button
                    type="button"
                    className="secondary-button"
                    disabled={loading || refreshing}
                    onClick={() => void run(api.refreshModels, true)}
                >
                    {refreshing ? 'Refreshing...' : 'Refresh from OpenRouter'}
                </button>
            </div>

            <div role="status" aria-live="polite">
                {data && (
                    <p className="field-hint">
                        Source: <strong>{sourceLabel(data.source)}</strong>
                        {data.fetchedAt ? ` - fetched ${formatRunTime(data.fetchedAt)}` : ' - fetch time unknown'}
                    </p>
                )}
                {refreshing && <p className="field-hint">Refreshing model data...</p>}
            </div>

            {error && (
                <p className="error-message" role="alert">
                    {error}
                </p>
            )}
            {data?.error && <p className="field-hint">Live data note: {data.error}</p>}

            {loading ? (
                <p>Loading models...</p>
            ) : !data ? (
                <p>Use Refresh from OpenRouter to try loading the models again.</p>
            ) : data.models.length === 0 ? (
                <div className="empty-state">
                    <h3>No models</h3>
                </div>
            ) : (
                <div className="table-scroll" tabIndex={0} role="region" aria-label="Models table, scrollable">
                    <table className="models-table">
                        <thead>
                            <tr>
                                <th scope="col">Model</th>
                                <th scope="col">Role</th>
                                <th scope="col">Status</th>
                                <th scope="col">Price</th>
                                <th scope="col">Context</th>
                                <th scope="col">Input</th>
                                <th scope="col">Output</th>
                                <th scope="col">Parameters</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.models.map((m) => (
                                <tr key={m.id} className={m.enabled ? '' : 'model-disabled'}>
                                    <th scope="row">
                                        {m.displayName}
                                        <br />
                                        <span className="field-hint">{m.id}</span>
                                    </th>
                                    <td>{m.role}</td>
                                    <td>
                                        <span className={`status${m.enabled ? '' : ' status-disabled'}`}>
                                            {m.enabled ? 'Enabled' : 'Disabled'}
                                        </span>
                                        {!m.enabled && <div className="field-hint">V2: not enabled</div>}
                                    </td>
                                    <td>
                                        {m.priceLabel}
                                        {m.pricingUnitNote && <div className="field-hint">{m.pricingUnitNote}</div>}
                                    </td>
                                    <td>{formatContext(m.contextLength)}</td>
                                    <td>{listOrDash(m.inputModalities)}</td>
                                    <td>{listOrDash(m.outputModalities)}</td>
                                    <td>
                                        <details>
                                            <summary>{m.supportedParameters.length} supported</summary>
                                            {listOrDash(m.supportedParameters)}
                                        </details>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
};

export default ModelsTab;
