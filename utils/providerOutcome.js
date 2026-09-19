const PROVIDER_OUTCOMES = Object.freeze({
    SUCCESS: 'success',
    DEFINITIVE_FAILURE: 'definitive_failure',
    PENDING: 'pending',
    UNKNOWN: 'unknown',
});

const validOutcomes = new Set(Object.values(PROVIDER_OUTCOMES));
const successStatuses = new Set(['success', 'successful', 'delivered', 'completed']);
const pendingStatuses = new Set(['pending', 'processing', 'in_progress', 'in-progress', 'queued']);
const failureStatuses = new Set(['failed', 'rejected', 'cancelled', 'canceled']);

const normalizeProviderOutcome = response => {
    if (!response || typeof response !== 'object') {
        return {
            success: false,
            status: 'unknown',
            outcome: PROVIDER_OUTCOMES.UNKNOWN,
            message: 'Provider returned an invalid response',
            raw: response,
        };
    }

    const status = typeof response.status === 'string' ? response.status.toLowerCase() : '';
    let outcome = validOutcomes.has(response.outcome) ? response.outcome : null;
    const signals = new Set();

    if (outcome && outcome !== PROVIDER_OUTCOMES.UNKNOWN) signals.add(outcome);
    if (response.success === true) signals.add(PROVIDER_OUTCOMES.SUCCESS);
    if (successStatuses.has(status)) signals.add(PROVIDER_OUTCOMES.SUCCESS);
    if (pendingStatuses.has(status)) signals.add(PROVIDER_OUTCOMES.PENDING);
    if (failureStatuses.has(status)) signals.add(PROVIDER_OUTCOMES.DEFINITIVE_FAILURE);

    if (outcome === PROVIDER_OUTCOMES.UNKNOWN || signals.size > 1) {
        outcome = PROVIDER_OUTCOMES.UNKNOWN;
    } else if (!outcome && signals.size === 1) {
        outcome = [...signals][0];
    }

    if (!outcome) {
        if (response.success === true && (!status || successStatuses.has(status))) {
            outcome = PROVIDER_OUTCOMES.SUCCESS;
        } else if (response.success === false && pendingStatuses.has(status)) {
            outcome = PROVIDER_OUTCOMES.PENDING;
        } else {
            outcome = PROVIDER_OUTCOMES.UNKNOWN;
        }
    }

    if (outcome === PROVIDER_OUTCOMES.SUCCESS && response.success !== true) {
        outcome = PROVIDER_OUTCOMES.UNKNOWN;
    }
    if (outcome !== PROVIDER_OUTCOMES.SUCCESS && response.success === true) {
        outcome = PROVIDER_OUTCOMES.UNKNOWN;
    }

    return {
        ...response,
        success: outcome === PROVIDER_OUTCOMES.SUCCESS,
        status: outcome === PROVIDER_OUTCOMES.SUCCESS
            ? 'success'
            : outcome === PROVIDER_OUTCOMES.DEFINITIVE_FAILURE
                ? 'failed'
                : outcome === PROVIDER_OUTCOMES.PENDING
                    ? 'pending'
                    : 'unknown',
        outcome,
    };
};

module.exports = { PROVIDER_OUTCOMES, normalizeProviderOutcome };
