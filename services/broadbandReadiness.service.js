const ServiceCategory = require('../models/ServiceCategory');
const ServiceType = require('../models/ServiceType');
const Brand = require('../models/Brand');
const Service = require('../models/Service');
const ServiceIdentity = require('../models/ServiceIdentity');
const ProviderOffer = require('../models/ProviderOffer');
const { PROVIDER_OPERATIONS, supportsProviderOperation } = require('../adapters/providerAdapterRegistry');

const idOf = value => value?._id || value;
const sameId = (left, right) => Boolean(idOf(left) && idOf(right))
    && String(idOf(left)) === String(idOf(right));
const active = value => Boolean(value) && value.status !== false && value.status !== 'inactive'
    && value.status !== 'maintenance';

const isBroadbandType = type => {
    if (!type) return false;
    const names = [type.slug, type.name, ...(Array.isArray(type.aliases) ? type.aliases : [])]
        .map(value => String(value || '').trim().toLowerCase());
    return names.includes('broadband');
};

const requiredOperationsForIdentity = identity => {
    const operations = [PROVIDER_OPERATIONS.PURCHASE_BROADBAND];
    if (identity?.verificationPolicy?.mode === 'required') {
        operations.push(identity.verificationPolicy.evidenceRequired
            ? PROVIDER_OPERATIONS.VERIFY_BROADBAND_EVIDENCE
            : PROVIDER_OPERATIONS.VERIFY_BROADBAND);
    }
    return operations;
};

function hierarchyErrors({ identity, service, category, type, brand }) {
    const errors = [];
    if (!active(category)) errors.push('Broadband category is missing or inactive');
    if (!active(type) || !isBroadbandType(type)) errors.push('Identity must reference an active Broadband service type');
    if (!active(brand)) errors.push('Broadband brand is missing or inactive');
    if (type && category && !sameId(type.categoryId, category)) errors.push('Service type does not belong to the identity category');
    if (brand && type && !(brand.typeIds || []).some(typeId => sameId(typeId, type))) {
        errors.push('Brand does not include the identity service type');
    }
    if (identity && category && !sameId(identity.categoryId, category)) errors.push('Identity category is inconsistent');
    if (identity && type && !sameId(identity.typeId, type)) errors.push('Identity service type is inconsistent');
    if (identity && brand && !sameId(identity.brandId, brand)) errors.push('Identity brand is inconsistent');

    if (service) {
        if (service.category !== 'broadband') errors.push('Service category must be broadband');
        if (!String(service.name || '').trim() || !String(service.code || '').trim()) {
            errors.push('Broadband service name and code are required');
        }
        if (!sameId(service.identityId, identity)) errors.push('Service does not belong to the identity');
        if (!service.categoryId || !sameId(service.categoryId, identity.categoryId)) errors.push('Service category hierarchy is inconsistent');
        if (!service.typeId || !sameId(service.typeId, identity.typeId)) errors.push('Service type hierarchy is inconsistent');
        if (!service.brandId || !sameId(service.brandId, identity.brandId)) errors.push('Service brand hierarchy is inconsistent');
    }
    return errors;
}

function policyErrors(identity) {
    const errors = [];
    if (!['plan', 'amount'].includes(identity?.purchaseMode)) errors.push('Broadband purchase mode is incomplete');
    if (!identity?.identifierPolicy?.label) errors.push('Broadband identifier policy is incomplete');
    if (!['none', 'optional', 'required'].includes(identity?.verificationPolicy?.mode)) {
        errors.push('Broadband verification policy is incomplete');
    }
    if (identity?.verificationPolicy?.evidenceRequired
        && identity.verificationPolicy.mode !== 'required') {
        errors.push('Verification evidence requires mandatory verification');
    }
    if (identity?.purchaseMode === 'amount') {
        const amountPolicy = identity.amountPolicy;
        if (!amountPolicy || !Number.isFinite(Number(amountPolicy.min)) || Number(amountPolicy.min) <= 0) {
            errors.push('Broadband amount minimum must be greater than zero');
        }
        if (!amountPolicy || !Number.isFinite(Number(amountPolicy.max))
            || Number(amountPolicy.max) < Number(amountPolicy.min)) {
            errors.push('Broadband amount maximum must be greater than or equal to minimum');
        }
        if (!amountPolicy || !Number.isFinite(Number(amountPolicy.step)) || Number(amountPolicy.step) <= 0) {
            errors.push('Broadband amount increment must be greater than zero');
        }
        if ((amountPolicy?.currency || 'NGN') !== 'NGN') errors.push('Broadband amount currency must be NGN');
    }
    return errors;
}

function offerErrors({ identity, service, offer }) {
    const errors = [];
    if (!offer || offer.status === false) return ['No active Broadband provider offer is configured'];
    if (!sameId(offer.serviceId, service)) errors.push('Provider offer does not belong to the service');
    if (!active(offer.providerId)) errors.push('Provider is not active');
    if (!String(offer.providerCode || '').trim() || !String(offer.providerServiceCode || '').trim()) {
        errors.push('Provider offer mapping is incomplete');
    }
    if ((offer.currency || 'NGN') !== 'NGN') errors.push('Provider offer currency must be NGN');
    if (identity.purchaseMode === 'plan' && offer.costMode !== 'fixed') {
        errors.push('Broadband PLAN offers must use fixed cost mode');
    }
    if (identity.purchaseMode === 'plan'
        && (!Number.isFinite(Number(offer.costPrice)) || Number(offer.costPrice) <= 0)) {
        errors.push('Broadband PLAN offer cost must be greater than zero');
    }
    if (identity.purchaseMode === 'amount' && offer.costMode !== 'dynamic') {
        errors.push('Broadband AMOUNT offers must use dynamic cost mode');
    }
    for (const operation of requiredOperationsForIdentity(identity)) {
        if (!supportsProviderOperation(offer.providerId, operation)) {
            errors.push(`Provider does not support required Broadband operation: ${operation}`);
        }
    }
    return errors;
}

async function loadIdentityHierarchy(identity) {
    const [category, type, brand] = await Promise.all([
        ServiceCategory.findById(idOf(identity.categoryId)),
        ServiceType.findById(idOf(identity.typeId)),
        Brand.findById(idOf(identity.brandId))
    ]);
    return { category, type, brand };
}

async function inspectIdentity(identity) {
    const hierarchy = await loadIdentityHierarchy(identity);
    const errors = [...policyErrors(identity), ...hierarchyErrors({ identity, ...hierarchy })];
    return { ready: errors.length === 0, errors, ...hierarchy };
}

async function inspectService(identity, service, { requireOffer = true } = {}) {
    const hierarchy = await loadIdentityHierarchy(identity);
    const errors = [
        ...policyErrors(identity),
        ...hierarchyErrors({ identity, service, ...hierarchy })
    ];
    let offer = null;
    if (requireOffer && errors.length === 0) {
        const offers = await ProviderOffer.find({ serviceId: service._id, status: true }).populate('providerId');
        const evaluated = (offers || []).map(candidate => ({
            candidate,
            errors: offerErrors({ identity, service, offer: candidate })
        }));
        offer = evaluated.find(result => result.errors.length === 0)?.candidate || null;
        if (evaluated.some(result => result.errors.length > 0)) {
            errors.push('An active Broadband provider offer is invalid');
        }
        if (!offer) errors.push('No eligible Broadband provider offer is configured');
    }
    return { ready: errors.length === 0, errors, offer, ...hierarchy };
}

async function isBroadbandIdentity(identity) {
    if (!identity?.typeId) return false;
    const populatedType = identity.typeId;
    if (populatedType?.slug && isBroadbandType(populatedType)) return true;
    const type = populatedType?.aliases ? populatedType : await ServiceType.findById(idOf(identity.typeId));
    return isBroadbandType(type);
}

async function assertActiveIdentity(identity) {
    if (!identity?.status) return;
    const services = await Service.find({ identityId: identity._id, category: 'broadband', status: true });
    if (!await isBroadbandIdentity(identity) && services.length === 0) return;
    const result = await inspectIdentity(identity);
    if (!result.ready) throw new Error(result.errors.join('; '));
    if (services.length === 0) throw new Error('Active Broadband identity requires an active purchase service');
    if (identity.purchaseMode === 'amount' && services.length !== 1) {
        throw new Error('Broadband AMOUNT identity must have exactly one active purchase service');
    }
    for (const service of services) {
        const serviceResult = await inspectService(identity, service);
        if (!serviceResult.ready) throw new Error(serviceResult.errors.join('; '));
    }
}

async function assertActiveService(service) {
    if (!service?.status || service.category !== 'broadband') return;
    const identity = await ServiceIdentity.findById(idOf(service.identityId));
    if (!identity) throw new Error('Active Broadband service requires an identity');
    if (!identity.status) return;
    if (identity.purchaseMode === 'amount') {
        const otherActiveServices = await Service.countDocuments({
            _id: { $ne: service._id },
            identityId: identity._id,
            category: 'broadband',
            status: true
        });
        if (otherActiveServices > 0) {
            throw new Error('Broadband AMOUNT identity must have exactly one active purchase service');
        }
    }
    const result = await inspectService(identity, service);
    if (!result.ready) throw new Error(result.errors.join('; '));
}

async function assertActiveOffer(offer) {
    if (!offer?.status) return;
    const service = await Service.findById(idOf(offer.serviceId));
    if (!service || service.category !== 'broadband' || !service.status) return;
    const identity = await ServiceIdentity.findById(idOf(service.identityId));
    if (!identity) throw new Error('Active Broadband offer requires an identity');
    if (!identity.status) return;
    const populatedOffer = await ProviderOffer.populate(offer, { path: 'providerId' });
    const result = await inspectService(identity, service, { requireOffer: false });
    const errors = [...result.errors, ...offerErrors({ identity, service, offer: populatedOffer })];
    if (errors.length) throw new Error(errors.join('; '));
}

async function assertActiveServiceRemoval(service) {
    if (!service?.status || service.category !== 'broadband') return;
    const identity = await ServiceIdentity.findById(idOf(service.identityId));
    if (!identity?.status || !await isBroadbandIdentity(identity)) return;
    const remaining = await Service.find({
        _id: { $ne: service._id },
        identityId: identity._id,
        category: 'broadband',
        status: true
    });
    if (remaining.length === 0) {
        throw new Error('Deactivate the Broadband identity before removing its last active service');
    }
    if (identity.purchaseMode === 'amount' && remaining.length !== 1) {
        throw new Error('Broadband AMOUNT identity must have exactly one active purchase service');
    }
    for (const candidate of remaining) {
        const result = await inspectService(identity, candidate);
        if (!result.ready) throw new Error(result.errors.join('; '));
    }
}

async function assertActiveOfferRemoval(offer) {
    if (!offer?.status) return;
    const service = await Service.findById(idOf(offer.serviceId));
    if (!service?.status || service.category !== 'broadband') return;
    const identity = await ServiceIdentity.findById(idOf(service.identityId));
    if (!identity?.status || !await isBroadbandIdentity(identity)) return;
    const offers = await ProviderOffer.find({
        _id: { $ne: offer._id },
        serviceId: service._id,
        status: true
    }).populate('providerId');
    const replacement = (offers || []).find(candidate => (
        offerErrors({ identity, service, offer: candidate }).length === 0
    ));
    if (!replacement) {
        throw new Error('Deactivate the Broadband identity before removing its last eligible provider offer');
    }
}

async function assertParentMutationSafe(identityFilter, label) {
    const identities = await ServiceIdentity.find({ ...identityFilter, status: true });
    for (const identity of identities) {
        if (await isBroadbandIdentity(identity)) {
            throw new Error(`Deactivate affected Broadband identities before changing ${label}`);
        }
    }
}

async function assertProviderMutationSafe(providerId) {
    const offers = await ProviderOffer.find({ providerId, status: true });
    for (const offer of offers) {
        const service = await Service.findById(idOf(offer.serviceId));
        if (!service?.status || service.category !== 'broadband') continue;
        const identity = await ServiceIdentity.findById(idOf(service.identityId));
        if (identity?.status && await isBroadbandIdentity(identity)) {
            throw new Error('Deactivate affected Broadband identities before changing provider routing');
        }
    }
}

module.exports = {
    sameId,
    isBroadbandType,
    isBroadbandIdentity,
    requiredOperationsForIdentity,
    hierarchyErrors,
    policyErrors,
    offerErrors,
    inspectIdentity,
    inspectService,
    assertActiveIdentity,
    assertActiveService,
    assertActiveOffer,
    assertActiveServiceRemoval,
    assertActiveOfferRemoval,
    assertParentMutationSafe,
    assertProviderMutationSafe
};
