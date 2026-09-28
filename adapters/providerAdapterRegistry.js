const PROVIDER_OPERATIONS = Object.freeze({
    PURCHASE_BROADBAND: 'purchaseBroadband',
    VERIFY_BROADBAND: 'verifyBroadband',
    VERIFY_BROADBAND_EVIDENCE: 'verifyBroadbandEvidence',
    QUERY_TRANSACTION: 'queryTransaction'
});

const toPlainMetadata = metadata => metadata instanceof Map
    ? Object.fromEntries(metadata)
    : (metadata || {});

const hasConfiguredValue = value => value !== undefined && value !== null && value !== '';
const hasRequiredMappings = (fieldMap, requiredFields) => {
    if (fieldMap === undefined) return true;
    return fieldMap && typeof fieldMap === 'object'
        && requiredFields.every(field => hasConfiguredValue(fieldMap[field]));
};
const hasResponsePair = (metadata, prefix, fallbackPrefix, suffix) => {
    const fallbackSuffix = fallbackPrefix
        ? suffix
        : `${suffix.charAt(0).toLowerCase()}${suffix.slice(1)}`;
    const path = metadata[`${prefix}${suffix}Path`] ?? metadata[`${fallbackPrefix}${fallbackSuffix}Path`];
    const value = metadata[`${prefix}${suffix}Value`] ?? metadata[`${fallbackPrefix}${fallbackSuffix}Value`];
    return hasConfiguredValue(path) && hasConfiguredValue(value);
};
const hasExplicitResponsePair = (metadata, prefix, suffix) => hasConfiguredValue(
    metadata[`${prefix}${suffix}Path`]
) && hasConfiguredValue(metadata[`${prefix}${suffix}Value`]);

function supportsProviderOperation(provider, operation) {
    if (!provider || provider.adapterType !== 'universal') return false;
    const metadata = toPlainMetadata(provider.metadata);

    if (operation === PROVIDER_OPERATIONS.PURCHASE_BROADBAND) {
        return hasConfiguredValue(metadata.broadbandPurchaseUrl)
            && hasConfiguredValue(metadata.broadbandSuccessPath)
            && hasConfiguredValue(metadata.broadbandSuccessValue)
            && hasExplicitResponsePair(metadata, 'broadband', 'Pending')
            && hasExplicitResponsePair(metadata, 'broadband', 'Failure')
            && hasConfiguredValue(metadata.queryUrl)
            && hasRequiredMappings(metadata.broadbandFieldMap ?? metadata.fieldMap, [
                'request_id', 'serviceID', 'variation_code', 'identifier', 'amount'
            ])
            && hasRequiredMappings(metadata.queryFieldMap ?? metadata.fieldMap, ['request_id'])
            && hasResponsePair(metadata, 'query', '', 'Success')
            && hasResponsePair(metadata, 'query', '', 'Pending')
            && hasResponsePair(metadata, 'query', '', 'Failure');
    }
    if (operation === PROVIDER_OPERATIONS.VERIFY_BROADBAND
        || operation === PROVIDER_OPERATIONS.VERIFY_BROADBAND_EVIDENCE) {
        const verificationConfigured = hasConfiguredValue(metadata.broadbandVerifyUrl)
            && hasConfiguredValue(metadata.broadbandVerifySuccessPath)
            && hasConfiguredValue(metadata.broadbandVerifySuccessValue)
            && hasExplicitResponsePair(metadata, 'broadbandVerify', 'Pending')
            && hasExplicitResponsePair(metadata, 'broadbandVerify', 'Failure')
            && hasRequiredMappings(metadata.broadbandVerifyFieldMap, [
                'serviceID', 'variation_code', 'identifier'
            ]);
        if (!verificationConfigured) return false;
        if (operation === PROVIDER_OPERATIONS.VERIFY_BROADBAND_EVIDENCE) {
            const purchaseMap = metadata.broadbandFieldMap ?? metadata.fieldMap;
            return hasConfiguredValue(metadata.broadbandVerifyReferencePath)
                && purchaseMap && hasConfiguredValue(purchaseMap.verification_reference);
        }
        return true;
    }
    if (operation === PROVIDER_OPERATIONS.QUERY_TRANSACTION) {
        return hasConfiguredValue(metadata.queryUrl);
    }
    return false;
}

module.exports = {
    PROVIDER_OPERATIONS,
    supportsProviderOperation
};
