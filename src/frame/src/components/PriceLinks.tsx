import React from 'react';
import { router } from '@forge/bridge';
import { GENERAL_PRICING_URL, isSafeOpenRouterUrl } from '../aiView';

type Props = {
    modelName?: string;
    modelUrl: string | null;
};

function openLink(url: string) {
    if (!isSafeOpenRouterUrl(url)) return;
    try {
        void Promise.resolve(router.open(url)).catch((err) => console.error('Could not open link', err));
    } catch (err) {
        // The URL text stays visible so it can be copied.
        console.error('Could not open link', err);
    }
}

const LinkItem: React.FC<{ label: string; url: string }> = ({ label, url }) => (
    <li>
        <button type="button" className="link-button" onClick={() => openLink(url)}>
            {label}
        </button>{' '}
        <code className="url-text">{url}</code>
    </li>
);

/** Links to check current pricing. Only https://openrouter.ai/... URLs are rendered. */
const PriceLinks: React.FC<Props> = ({ modelName, modelUrl }) => (
    <div className="price-links">
        <p className="field-hint">Check the current price on OpenRouter before you confirm:</p>
        <ul>
            <LinkItem label="General pricing" url={GENERAL_PRICING_URL} />
            {modelUrl !== null && isSafeOpenRouterUrl(modelUrl) && (
                <LinkItem label={`${modelName ?? 'Model'} pricing`} url={modelUrl} />
            )}
        </ul>
    </div>
);

export default PriceLinks;
