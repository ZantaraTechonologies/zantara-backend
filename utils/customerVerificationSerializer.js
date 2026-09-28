const cleanText = (value, maxLength) => {
    if (typeof value !== 'string') return undefined;
    const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
    return cleaned ? cleaned.slice(0, maxLength) : undefined;
};

function serializeBroadbandVerification({
    customerName,
    verified,
    identifierMasked,
    verificationContext,
    idempotencyKey,
    serviceIdentityId,
    planId,
    expiresAt,
    price
}) {
    const dto = {
        verified: Boolean(verified),
        status: verified ? 'verified' : 'verification_not_required',
        message: verified ? 'Customer verified' : 'Customer verification was not required',
        identifierMasked,
        verificationContext,
        idempotencyKey,
        serviceIdentityId,
        ...(planId ? { planId } : {}),
        expiresAt
    };
    const safeName = cleanText(customerName, 120);
    if (safeName) dto.customerName = safeName;
    if (price) dto.price = {
        salePrice: price.salePrice,
        referencePrice: price.retailPrice,
        savings: price.savings,
        currency: 'NGN'
    };
    return dto;
}

module.exports = { serializeBroadbandVerification };
