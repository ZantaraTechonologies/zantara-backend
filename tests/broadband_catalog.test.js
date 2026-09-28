'use strict';

const assert = require('assert');
const mongoose = require('mongoose');

const Service = require('../models/Service');
const ServiceIdentity = require('../models/ServiceIdentity');
const ServiceType = require('../models/ServiceType');
const ProviderOffer = require('../models/ProviderOffer');
const AuditLog = require('../models/AuditLog');
const procurementService = require('../services/procurement.service');
const pricingService = require('../services/pricing.service');
const servicesController = require('../controllers/servicesController');
const adminHierarchyController = require('../controllers/adminHierarchyController');
const serviceController = require('../controllers/serviceController');
const broadbandReadiness = require('../services/broadbandReadiness.service');
const servicesRouter = require('../routes/services');
const { verifyJWT } = require('../middlewares/auth');

const makeResponse = () => ({
    statusCode: 200,
    body: null,
    status(code) {
        this.statusCode = code;
        return this;
    },
    json(body) {
        this.body = body;
        return this;
    }
});

const chainResult = value => {
    const query = {
        populate() {
            return this;
        },
        sort() {
            return this;
        },
        then(resolve, reject) {
            return Promise.resolve(value).then(resolve, reject);
        }
    };
    return query;
};

const baseIdentity = overrides => ({
    name: 'Example Broadband',
    internalCode: `BROADBAND_${new mongoose.Types.ObjectId()}`,
    slug: `broadband-${new mongoose.Types.ObjectId()}`,
    categoryId: new mongoose.Types.ObjectId(),
    typeId: new mongoose.Types.ObjectId(),
    brandId: new mongoose.Types.ObjectId(),
    ...overrides
});

async function run() {
    let passed = 0;
    let failed = 0;

    const test = async (name, fn) => {
        try {
            await fn();
            console.log(`[PASS] ${name}`);
            passed++;
        } catch (error) {
            console.error(`[FAIL] ${name}: ${error.message}`);
            failed++;
        }
    };

    await test('legacy identities remain valid without purchase policies', () => {
        const identity = new ServiceIdentity(baseIdentity());
        assert.strictEqual(identity.validateSync(), undefined);
    });

    await test('plan identities require typed identifier and verification policies', () => {
        const identity = new ServiceIdentity(baseIdentity({ purchaseMode: 'plan' }));
        const error = identity.validateSync();
        assert.ok(error?.errors?.identifierPolicy);
        assert.ok(error?.errors?.verificationPolicy);
    });

    await test('amount identities require a valid amount range', () => {
        const identity = new ServiceIdentity(baseIdentity({
            purchaseMode: 'amount',
            identifierPolicy: { label: 'Account number', kind: 'numeric' },
            verificationPolicy: { mode: 'required' },
            amountPolicy: { min: 5000, max: 1000 }
        }));
        const error = identity.validateSync();
        assert.ok(error?.errors?.['amountPolicy.max']);
    });

    await test('amount identities reject zero minimum and unsupported currency', () => {
        const zeroMinimum = new ServiceIdentity(baseIdentity({
            purchaseMode: 'amount',
            identifierPolicy: { label: 'Account number', kind: 'numeric' },
            verificationPolicy: { mode: 'none' },
            amountPolicy: { min: 0, max: 1000, step: 1, currency: 'NGN' }
        }));
        assert.ok(zeroMinimum.validateSync()?.errors?.['amountPolicy.min']);

        const unsupportedCurrency = new ServiceIdentity(baseIdentity({
            purchaseMode: 'amount',
            identifierPolicy: { label: 'Account number', kind: 'numeric' },
            verificationPolicy: { mode: 'none' },
            amountPolicy: { min: 1, max: 1000, step: 1, currency: 'USD' }
        }));
        assert.ok(unsupportedCurrency.validateSync()?.errors?.['amountPolicy.currency']);
    });

    await test('verification evidence requires mandatory verification mode', () => {
        const identity = new ServiceIdentity(baseIdentity({
            purchaseMode: 'plan',
            identifierPolicy: { label: 'Account number' },
            verificationPolicy: { mode: 'optional', evidenceRequired: true }
        }));
        assert.ok(identity.validateSync()?.errors?.['verificationPolicy.evidenceRequired']);
    });

    await test('typed broadband policies validate and preserve their types', () => {
        const identity = new ServiceIdentity(baseIdentity({
            purchaseMode: 'amount',
            identifierPolicy: {
                label: 'Subscriber ID',
                kind: 'numeric',
                pattern: '^\\d{10}$',
                minLength: 10,
                maxLength: 10,
                normalization: 'digits_only'
            },
            verificationPolicy: { mode: 'required', ttlSeconds: 180 },
            amountPolicy: { min: 1000, max: 50000, step: 100, currency: 'ngn' }
        }));
        assert.strictEqual(identity.validateSync(), undefined);
        assert.strictEqual(identity.verificationPolicy.mode, 'required');
        assert.strictEqual(identity.amountPolicy.min, 1000);
        assert.strictEqual(identity.amountPolicy.currency, 'NGN');
    });

    await test('invalid identifier regular expressions are rejected', () => {
        const identity = new ServiceIdentity(baseIdentity({
            purchaseMode: 'plan',
            identifierPolicy: { label: 'Subscriber ID', pattern: '[' },
            verificationPolicy: { mode: 'none' }
        }));
        assert.ok(identity.validateSync()?.errors?.['identifierPolicy.pattern']);
    });

    await test('Service accepts broadband as a category', () => {
        const service = new Service({ name: 'Broadband Plan', category: 'broadband' });
        assert.strictEqual(service.validateSync(), undefined);
    });

    await test('Broadband readiness rejects hierarchy mismatches', () => {
        const category = { _id: new mongoose.Types.ObjectId(), status: true };
        const type = {
            _id: new mongoose.Types.ObjectId(), categoryId: category._id,
            slug: 'broadband', status: true
        };
        const brand = { _id: new mongoose.Types.ObjectId(), typeIds: [], status: true };
        const identity = {
            _id: new mongoose.Types.ObjectId(), categoryId: category._id,
            typeId: type._id, brandId: brand._id
        };
        const service = {
            _id: new mongoose.Types.ObjectId(), identityId: identity._id,
            categoryId: category._id, typeId: type._id,
            brandId: new mongoose.Types.ObjectId(), category: 'broadband'
        };
        const errors = broadbandReadiness.hierarchyErrors({ identity, service, category, type, brand });
        assert.ok(errors.some(error => error.includes('Brand does not include')));
        assert.ok(errors.some(error => error.includes('Service brand hierarchy')));
    });

    await test('Alias-only Broadband service types are recognized', async () => {
        const originalFindById = ServiceType.findById;
        const typeId = new mongoose.Types.ObjectId();
        try {
            ServiceType.findById = async () => ({
                _id: typeId,
                name: 'Fixed Internet',
                slug: 'fixed-internet',
                aliases: ['broadband']
            });
            assert.strictEqual(await broadbandReadiness.isBroadbandIdentity({
                typeId: { _id: typeId, name: 'Fixed Internet', slug: 'fixed-internet' }
            }), true);
        } finally {
            ServiceType.findById = originalFindById;
        }
    });

    await test('Legacy service operations constrain lookups to their own active categories', async () => {
        const originalServiceFindOne = Service.findOne;
        const originalIdentityFindOne = ServiceIdentity.findOne;
        const cases = [
            [servicesController.purchaseAirtime, 'airtime', {
                network: 'NETWORK', phone: '08012345678', amount: 100, pin: '1234'
            }],
            [servicesController.purchaseData, 'data', {
                serviceID: 'NETWORK', variation_code: 'PLAN', phone: '08012345678', amount: 100, pin: '1234'
            }],
            [servicesController.payElectricityBill, 'electricity', {
                serviceID: 'POWER', meter_number: '1234', meter_type: 'prepaid', amount: 1000,
                phone: '08012345678', pin: '1234'
            }],
            [servicesController.rechargeCable, 'tv', {
                serviceID: 'TV', billersCode: '1234', variation_code: 'PLAN', amount: 1000, pin: '1234'
            }],
            [servicesController.purchaseExamPin, 'pin', {
                serviceID: 'EXAM', variation_code: 'PIN', amount: 1000, quantity: 1, pin: '1234'
            }],
            [servicesController.verifyMeter, 'electricity', { serviceID: 'POWER', billersCode: '1234' }],
            [servicesController.verifySmartcard, 'tv', { serviceID: 'TV', billersCode: '1234' }],
            [servicesController.verifyExamProfile, 'pin', { serviceID: 'EXAM', billersCode: '1234' }]
        ];
        try {
            ServiceIdentity.findOne = async () => null;
            for (const [handler, category, body] of cases) {
                const queries = [];
                Service.findOne = query => {
                    queries.push(query);
                    return chainResult(null);
                };
                await handler({ body, user: { id: new mongoose.Types.ObjectId() } }, makeResponse());
                assert.strictEqual(queries[0].category, category);
                assert.strictEqual(queries[0].status, true);
            }
        } finally {
            Service.findOne = originalServiceFindOne;
            ServiceIdentity.findOne = originalIdentityFindOne;
        }
    });

    await test('Broadband readiness requires verification capability and configured evidence mapping', () => {
        const service = { _id: new mongoose.Types.ObjectId() };
        const purchaseMetadata = {
            broadbandPurchaseUrl: '/buy',
            broadbandSuccessPath: 'code',
            broadbandSuccessValue: '00',
            broadbandPendingPath: 'status',
            broadbandPendingValue: 'pending',
            broadbandFailurePath: 'status',
            broadbandFailureValue: 'failed',
            queryUrl: '/query',
            querySuccessPath: 'code', querySuccessValue: '00',
            queryPendingPath: 'status', queryPendingValue: 'pending',
            queryFailurePath: 'status', queryFailureValue: 'failed'
        };
        const offer = {
            serviceId: service._id,
            status: true,
            providerCode: 'PLAN',
            providerServiceCode: 'BROADBAND',
            currency: 'NGN',
            costMode: 'fixed',
            providerId: { status: 'active', adapterType: 'universal', metadata: purchaseMetadata }
        };
        const requiredIdentity = {
            purchaseMode: 'plan',
            verificationPolicy: { mode: 'required', evidenceRequired: false }
        };
        assert.ok(broadbandReadiness.offerErrors({ identity: requiredIdentity, service, offer })
            .some(error => error.includes('verifyBroadband')));

        offer.providerId.metadata = {
            ...purchaseMetadata,
            broadbandVerifyUrl: '/verify',
            broadbandVerifySuccessPath: 'code',
            broadbandVerifySuccessValue: '00',
            broadbandVerifyPendingPath: 'status',
            broadbandVerifyPendingValue: 'pending',
            broadbandVerifyFailurePath: 'status',
            broadbandVerifyFailureValue: 'failed'
        };
        const evidenceIdentity = {
            purchaseMode: 'plan',
            verificationPolicy: { mode: 'required', evidenceRequired: true }
        };
        assert.ok(broadbandReadiness.offerErrors({ identity: evidenceIdentity, service, offer })
            .some(error => error.includes('verifyBroadbandEvidence')));
    });

    await test('canonical plans route is JWT protected', () => {
        const layer = servicesRouter.stack.find(item => item.route?.path === '/identities/:serviceIdentityId/plans');
        assert.ok(layer, 'canonical plans route must exist');
        const handlers = layer.route.stack.map(item => item.handle);
        assert.strictEqual(handlers[0], verifyJWT);
        assert.strictEqual(handlers[1], servicesController.getPlansByIdentityId);
    });

    await test('canonical plans endpoint rejects malformed identity IDs', async () => {
        const res = makeResponse();
        await servicesController.getPlansByIdentityId({ params: { serviceIdentityId: 'invalid' }, user: {} }, res);
        assert.strictEqual(res.statusCode, 400);
    });

    await test('Broadband identity discovery returns only ready canonical DTOs', async () => {
        const originals = {
            typeFindOne: ServiceType.findOne,
            identityFind: ServiceIdentity.find,
            serviceFind: Service.find,
            inspectIdentity: broadbandReadiness.inspectIdentity,
            inspectService: broadbandReadiness.inspectService
        };
        const type = { _id: new mongoose.Types.ObjectId(), name: 'Fixed Internet', slug: 'fixed', aliases: ['broadband'] };
        const identity = {
            _id: new mongoose.Types.ObjectId(),
            name: 'ISP',
            slug: 'isp',
            internalCode: 'PRIVATE',
            providerCode: 'PRIVATE_PROVIDER_CODE',
            purchaseMode: 'plan',
            identifierPolicy: { label: 'Subscriber ID' },
            verificationPolicy: { mode: 'none' },
            typeId: type,
            brandId: { _id: new mongoose.Types.ObjectId(), name: 'ISP Brand' }
        };
        try {
            ServiceType.findOne = async () => type;
            ServiceIdentity.find = () => chainResult([identity]);
            Service.find = async () => [{
                _id: new mongoose.Types.ObjectId(), identityId: identity._id,
                category: 'broadband', status: true
            }];
            broadbandReadiness.inspectIdentity = async () => ({ ready: true, errors: [] });
            broadbandReadiness.inspectService = async () => ({ ready: true, errors: [] });
            const res = makeResponse();
            await servicesController.getIdentitiesByCategory({ query: { category: 'fixed' } }, res);
            assert.strictEqual(res.body.data.length, 1);
            assert.strictEqual(String(res.body.data[0].serviceIdentityId), String(identity._id));
            assert.strictEqual(res.body.data[0]._id, undefined);
            assert.strictEqual(res.body.data[0].internalCode, undefined);
            assert.strictEqual(res.body.data[0].providerCode, undefined);
        } finally {
            ServiceType.findOne = originals.typeFindOne;
            ServiceIdentity.find = originals.identityFind;
            Service.find = originals.serviceFind;
            broadbandReadiness.inspectIdentity = originals.inspectIdentity;
            broadbandReadiness.inspectService = originals.inspectService;
        }
    });

    await test('Admin identity updates validate the complete purchase policy', async () => {
        const originalFindById = ServiceIdentity.findById;
        const originalAuditCreate = AuditLog.create;
        const originalAssertActiveIdentity = broadbandReadiness.assertActiveIdentity;
        const identity = new ServiceIdentity(baseIdentity());
        identity.save = async function save() {
            const error = this.validateSync();
            if (error) throw error;
            return this;
        };

        try {
            ServiceIdentity.findById = async () => identity;
            AuditLog.create = async () => ({});
            broadbandReadiness.assertActiveIdentity = async () => {};

            const res = makeResponse();
            await adminHierarchyController.updateServiceIdentity({
                params: { id: String(identity._id) },
                body: { purchaseMode: 'plan' },
                user: { id: new mongoose.Types.ObjectId(), name: 'Admin' },
                headers: {},
                ip: '127.0.0.1'
            }, res);

            assert.strictEqual(res.statusCode, 400);
            assert.match(res.body.message, /identifierPolicy/);
        } finally {
            ServiceIdentity.findById = originalFindById;
            AuditLog.create = originalAuditCreate;
            broadbandReadiness.assertActiveIdentity = originalAssertActiveIdentity;
        }
    });

    await test('Broadband Service updates use document validation and readiness checks', async () => {
        const originals = {
            serviceFindById: Service.findById,
            serviceFindByIdAndUpdate: Service.findByIdAndUpdate,
            assertActiveService: broadbandReadiness.assertActiveService
        };
        let readinessChecks = 0;
        let legacyUpdates = 0;
        const service = {
            category: 'broadband',
            set(patch) { Object.assign(this, patch); },
            async save() { return this; }
        };
        try {
            Service.findById = async () => service;
            Service.findByIdAndUpdate = async () => { legacyUpdates++; };
            broadbandReadiness.assertActiveService = async () => { readinessChecks++; };
            const res = makeResponse();
            await serviceController.updateService({ params: { id: 'service-id' }, body: { name: 'Updated' } }, res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(readinessChecks, 1);
            assert.strictEqual(legacyUpdates, 0);
        } finally {
            Service.findById = originals.serviceFindById;
            Service.findByIdAndUpdate = originals.serviceFindByIdAndUpdate;
            broadbandReadiness.assertActiveService = originals.assertActiveService;
        }
    });

    await test('Broadband ProviderOffer updates use document validation and readiness checks', async () => {
        const originals = {
            offerFindById: ProviderOffer.findById,
            offerFindByIdAndUpdate: ProviderOffer.findByIdAndUpdate,
            serviceFindById: Service.findById,
            auditCreate: AuditLog.create,
            assertActiveOffer: broadbandReadiness.assertActiveOffer
        };
        let readinessChecks = 0;
        let legacyUpdates = 0;
        const offer = {
            serviceId: new mongoose.Types.ObjectId(),
            set(patch) { Object.assign(this, patch); },
            async save() { return this; }
        };
        try {
            ProviderOffer.findById = async () => offer;
            ProviderOffer.findByIdAndUpdate = async () => { legacyUpdates++; };
            Service.findById = async () => ({ category: 'broadband' });
            AuditLog.create = async () => ({});
            broadbandReadiness.assertActiveOffer = async () => { readinessChecks++; };
            const res = makeResponse();
            await adminHierarchyController.updateProviderOffer({
                params: { id: 'offer-id' },
                body: { costMode: 'fixed', costPrice: 1000 },
                user: { id: new mongoose.Types.ObjectId(), name: 'Admin' },
                headers: {},
                ip: '127.0.0.1'
            }, res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(readinessChecks, 1);
            assert.strictEqual(legacyUpdates, 0);
        } finally {
            ProviderOffer.findById = originals.offerFindById;
            ProviderOffer.findByIdAndUpdate = originals.offerFindByIdAndUpdate;
            Service.findById = originals.serviceFindById;
            AuditLog.create = originals.auditCreate;
            broadbandReadiness.assertActiveOffer = originals.assertActiveOffer;
        }
    });

    await test('Active Broadband service and offer removal paths enforce readiness guards', async () => {
        const originals = {
            serviceFindById: Service.findById,
            serviceRemoval: broadbandReadiness.assertActiveServiceRemoval,
            activeService: broadbandReadiness.assertActiveService,
            offerFindById: ProviderOffer.findById,
            offerRemoval: broadbandReadiness.assertActiveOfferRemoval,
            activeOffer: broadbandReadiness.assertActiveOffer,
            auditCreate: AuditLog.create
        };
        let serviceRemovalChecks = 0;
        let offerRemovalChecks = 0;
        const service = {
            category: 'broadband', status: true, identityId: new mongoose.Types.ObjectId(),
            set(patch) { Object.assign(this, patch); },
            async save() { return this; }
        };
        const offer = {
            _id: new mongoose.Types.ObjectId(), serviceId: new mongoose.Types.ObjectId(), status: true,
            set(patch) { Object.assign(this, patch); },
            async save() { return this; }
        };
        try {
            Service.findById = async id => String(id) === 'service-id' ? service : { category: 'broadband' };
            broadbandReadiness.assertActiveServiceRemoval = async () => { serviceRemovalChecks++; };
            broadbandReadiness.assertActiveService = async () => {};
            let res = makeResponse();
            await serviceController.updateService({ params: { id: 'service-id' }, body: { status: false } }, res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(serviceRemovalChecks, 1);

            ProviderOffer.findById = async () => offer;
            broadbandReadiness.assertActiveOfferRemoval = async () => { offerRemovalChecks++; };
            broadbandReadiness.assertActiveOffer = async () => {};
            AuditLog.create = async () => ({});
            res = makeResponse();
            await adminHierarchyController.updateProviderOffer({
                params: { id: 'offer-id' },
                body: { status: false },
                user: { id: new mongoose.Types.ObjectId(), name: 'Admin' },
                headers: {}, ip: '127.0.0.1'
            }, res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(offerRemovalChecks, 1);
        } finally {
            Service.findById = originals.serviceFindById;
            broadbandReadiness.assertActiveServiceRemoval = originals.serviceRemoval;
            broadbandReadiness.assertActiveService = originals.activeService;
            ProviderOffer.findById = originals.offerFindById;
            broadbandReadiness.assertActiveOfferRemoval = originals.offerRemoval;
            broadbandReadiness.assertActiveOffer = originals.activeOffer;
            AuditLog.create = originals.auditCreate;
        }
    });

    await test('Direct Service deletion rejects linked ProviderOffers without mutating Broadband state', async () => {
        const originals = {
            serviceFindById: Service.findById,
            serviceFindByIdAndDelete: Service.findByIdAndDelete,
            offerExists: ProviderOffer.exists,
            serviceRemoval: broadbandReadiness.assertActiveServiceRemoval
        };
        let deletes = 0;
        let readinessChecks = 0;
        try {
            Service.findById = async () => ({
                _id: new mongoose.Types.ObjectId(),
                category: 'broadband',
                status: true
            });
            Service.findByIdAndDelete = async () => { deletes++; };
            ProviderOffer.exists = async filter => {
                assert.deepStrictEqual(filter, { serviceId: 'service-id' });
                return { _id: new mongoose.Types.ObjectId() };
            };
            broadbandReadiness.assertActiveServiceRemoval = async () => { readinessChecks++; };
            const res = makeResponse();
            await serviceController.deleteService({ params: { id: 'service-id' } }, res);
            assert.strictEqual(res.statusCode, 409);
            assert.match(res.body.message, /provider offers are linked/i);
            assert.strictEqual(deletes, 0);
            assert.strictEqual(readinessChecks, 0);
        } finally {
            Service.findById = originals.serviceFindById;
            Service.findByIdAndDelete = originals.serviceFindByIdAndDelete;
            ProviderOffer.exists = originals.offerExists;
            broadbandReadiness.assertActiveServiceRemoval = originals.serviceRemoval;
        }
    });

    await test('Unlinked legacy Service deletion remains compatible and Broadband readiness still applies', async () => {
        const originals = {
            serviceFindById: Service.findById,
            serviceFindByIdAndDelete: Service.findByIdAndDelete,
            offerExists: ProviderOffer.exists,
            serviceRemoval: broadbandReadiness.assertActiveServiceRemoval
        };
        let deletes = 0;
        try {
            ProviderOffer.exists = async () => null;
            Service.findByIdAndDelete = async () => { deletes++; };
            broadbandReadiness.assertActiveServiceRemoval = async service => {
                if (service.category === 'broadband') throw new Error('Active Broadband configuration must remain ready');
            };

            Service.findById = async () => ({ category: 'data', status: true });
            let res = makeResponse();
            await serviceController.deleteService({ params: { id: 'legacy-service' } }, res);
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(deletes, 1);

            Service.findById = async () => ({ category: 'broadband', status: true });
            res = makeResponse();
            await serviceController.deleteService({ params: { id: 'broadband-service' } }, res);
            assert.strictEqual(res.statusCode, 409);
            assert.match(res.body.message, /must remain ready/);
            assert.strictEqual(deletes, 1);
        } finally {
            Service.findById = originals.serviceFindById;
            Service.findByIdAndDelete = originals.serviceFindByIdAndDelete;
            ProviderOffer.exists = originals.offerExists;
            broadbandReadiness.assertActiveServiceRemoval = originals.serviceRemoval;
        }
    });

    await test('Broadband discovery responses contain no internal diagnostics', async () => {
        const malicious = 'Bearer SUPER-SECRET https://provider.internal/api {"apiKey":"SECRET"} providerCode=vtpass\r\nMongoServerError internal diagnostic';
        const originals = {
            typeFindOne: ServiceType.findOne,
            identityFindOne: ServiceIdentity.findOne
        };
        try {
            ServiceType.findOne = () => { throw new Error(malicious); };
            let res = makeResponse();
            await servicesController.getIdentitiesByCategory({ query: { category: 'broadband' } }, res);
            assert.strictEqual(res.statusCode, 503);
            assert.strictEqual(res.body.error, null);
            assert.ok(!JSON.stringify(res.body).includes(malicious));
            assert.ok(!JSON.stringify(res.body).includes('SUPER-SECRET'));

            ServiceIdentity.findOne = () => ({
                populate() { throw new Error(malicious); }
            });
            res = makeResponse();
            await servicesController.getPlansByIdentityId({
                params: { serviceIdentityId: String(new mongoose.Types.ObjectId()) },
                user: {}
            }, res);
            assert.strictEqual(res.statusCode, 503);
            assert.strictEqual(res.body.error, null);
            assert.ok(!JSON.stringify(res.body).includes(malicious));
            assert.ok(!JSON.stringify(res.body).includes('provider.internal'));
        } finally {
            ServiceType.findOne = originals.typeFindOne;
            ServiceIdentity.findOne = originals.identityFindOne;
        }
    });

    await test('Active Broadband AMOUNT identities reject a second active service', async () => {
        const originals = {
            identityFindById: ServiceIdentity.findById,
            serviceCountDocuments: Service.countDocuments
        };
        try {
            ServiceIdentity.findById = async () => ({
                _id: new mongoose.Types.ObjectId(),
                status: true,
                purchaseMode: 'amount'
            });
            Service.countDocuments = async () => 1;
            await assert.rejects(broadbandReadiness.assertActiveService({
                _id: new mongoose.Types.ObjectId(),
                identityId: new mongoose.Types.ObjectId(),
                category: 'broadband',
                status: true
            }), /exactly one active purchase service/);
        } finally {
            ServiceIdentity.findById = originals.identityFindById;
            Service.countDocuments = originals.serviceCountDocuments;
        }
    });

    await test('Active Broadband identities block provider routing mutations', async () => {
        const originals = {
            offerFind: ProviderOffer.find,
            serviceFindById: Service.findById,
            identityFindById: ServiceIdentity.findById
        };
        const identityId = new mongoose.Types.ObjectId();
        try {
            ProviderOffer.find = async () => [{ serviceId: new mongoose.Types.ObjectId() }];
            Service.findById = async () => ({
                identityId,
                category: 'broadband',
                status: true
            });
            ServiceIdentity.findById = async () => ({
                _id: identityId,
                status: true,
                typeId: { slug: 'broadband' }
            });
            await assert.rejects(
                broadbandReadiness.assertProviderMutationSafe(new mongoose.Types.ObjectId()),
                /Deactivate affected Broadband identities/
            );
        } finally {
            ProviderOffer.find = originals.offerFind;
            Service.findById = originals.serviceFindById;
            ServiceIdentity.findById = originals.identityFindById;
        }
    });

    const originals = {
        identityFindOne: ServiceIdentity.findOne,
        identityFindById: ServiceIdentity.findById,
        serviceFind: Service.find,
        selectBestOffer: procurementService.selectBestOffer,
        resolvePricing: pricingService.resolvePricing,
        isBroadbandIdentity: broadbandReadiness.isBroadbandIdentity,
        inspectIdentity: broadbandReadiness.inspectIdentity,
        inspectService: broadbandReadiness.inspectService,
        hierarchyErrors: broadbandReadiness.hierarchyErrors
    };

    try {
        await test('canonical plans expose priced fulfillable services without provider internals', async () => {
            const identityId = new mongoose.Types.ObjectId();
            const serviceId = new mongoose.Types.ObjectId();
            const identity = {
                _id: identityId,
                name: 'Example Broadband',
                slug: 'example-broadband',
                purchaseMode: 'plan',
                identifierPolicy: { label: 'Subscriber ID', kind: 'text' },
                verificationPolicy: { mode: 'required', evidenceRequired: false, ttlSeconds: 300 },
                amountPolicy: null,
                brandId: { _id: new mongoose.Types.ObjectId(), name: 'Example ISP' },
                typeId: { _id: new mongoose.Types.ObjectId(), name: 'Broadband', slug: 'broadband' }
            };
            const service = {
                _id: serviceId,
                identityId,
                name: '20 GB Plan',
                code: 'EXAMPLE_20GB',
                category: 'broadband',
                categoryId: new mongoose.Types.ObjectId(),
                typeId: identity.typeId._id,
                brandId: identity.brandId._id,
                inputSchema: { identifier: { required: true } },
                fulfillmentMode: 'sync',
                provider: 'must-not-leak',
                providerCode: 'must-not-leak',
                costPrice: 9000
            };

            ServiceIdentity.findOne = () => chainResult(identity);
            Service.find = () => chainResult([service]);
            broadbandReadiness.isBroadbandIdentity = async () => true;
            broadbandReadiness.inspectIdentity = async () => ({ ready: true, errors: [] });
            broadbandReadiness.inspectService = async () => ({ ready: true, errors: [] });
            broadbandReadiness.hierarchyErrors = () => [];
            procurementService.selectBestOffer = async () => ({
                costPrice: 9000,
                costMode: 'fixed',
                currency: 'NGN',
                providerCode: 'must-not-leak',
                providerServiceCode: 'must-not-leak'
            });
            pricingService.resolvePricing = async () => ({
                salePrice: 9500,
                retailPrice: 10000,
                savings: 500
            });

            const res = makeResponse();
            await servicesController.getPlansByIdentityId({ params: { serviceIdentityId: String(identityId) }, user: {} }, res);

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.identity.purchaseMode, 'plan');
            assert.strictEqual(res.body.data.plans.length, 1);
            assert.strictEqual(String(res.body.data.identity.serviceIdentityId), String(identityId));
            assert.strictEqual(String(res.body.data.plans[0].planId), String(serviceId));
            assert.strictEqual(res.body.data.plans[0].price.salePrice, 9500);
            assert.strictEqual(res.body.data.plans[0].provider, undefined);
            assert.strictEqual(res.body.data.plans[0].providerCode, undefined);
            assert.strictEqual(res.body.data.plans[0].costPrice, undefined);
        });

        await test('canonical plans omit services without an active provider offer', async () => {
            const identityId = new mongoose.Types.ObjectId();
            ServiceIdentity.findOne = () => chainResult({
                _id: identityId,
                name: 'Example Broadband',
                slug: 'example-broadband',
                purchaseMode: 'plan',
                identifierPolicy: { label: 'Subscriber ID' },
                verificationPolicy: { mode: 'none', evidenceRequired: false }
            });
            Service.find = () => chainResult([{ _id: new mongoose.Types.ObjectId() }]);
            procurementService.selectBestOffer = async () => null;
            broadbandReadiness.isBroadbandIdentity = async () => true;
            broadbandReadiness.inspectIdentity = async () => ({ ready: true, errors: [] });
            broadbandReadiness.hierarchyErrors = () => [];

            const res = makeResponse();
            await servicesController.getPlansByIdentityId({ params: { serviceIdentityId: String(identityId) }, user: {} }, res);
            assert.deepStrictEqual(res.body.data.plans, []);
        });

        await test('canonical Broadband discovery omits wrong-category and inactive services', async () => {
            const identityId = new mongoose.Types.ObjectId();
            const identity = {
                _id: identityId,
                name: 'Example Broadband',
                slug: 'example-broadband',
                purchaseMode: 'plan',
                identifierPolicy: { label: 'Subscriber ID' },
                verificationPolicy: { mode: 'none', evidenceRequired: false }
            };
            ServiceIdentity.findOne = () => chainResult(identity);
            Service.find = () => chainResult([
                { _id: new mongoose.Types.ObjectId(), identityId, category: 'data', status: true },
                { _id: new mongoose.Types.ObjectId(), identityId, category: 'broadband', status: false }
            ]);
            broadbandReadiness.isBroadbandIdentity = async () => true;
            broadbandReadiness.inspectIdentity = async () => ({ ready: true, errors: [] });
            broadbandReadiness.hierarchyErrors = () => [];
            let offerSelections = 0;
            procurementService.selectBestOffer = async () => { offerSelections++; return null; };

            const res = makeResponse();
            await servicesController.getPlansByIdentityId({ params: { serviceIdentityId: String(identityId) }, user: {} }, res);
            assert.deepStrictEqual(res.body.data.plans, []);
            assert.strictEqual(offerSelections, 0);
        });

        await test('AMOUNT identity is not presented as a plan list', async () => {
            const identityId = new mongoose.Types.ObjectId();
            ServiceIdentity.findOne = () => chainResult({
                _id: identityId,
                name: 'Broadband Top-up',
                slug: 'broadband-topup',
                purchaseMode: 'amount',
                identifierPolicy: { label: 'Subscriber ID' },
                verificationPolicy: { mode: 'none', evidenceRequired: false },
                amountPolicy: { min: 100, max: 10000, step: 100, currency: 'NGN' }
            });
            Service.find = () => chainResult([{
                _id: new mongoose.Types.ObjectId(), identityId, category: 'broadband', status: true
            }]);
            broadbandReadiness.isBroadbandIdentity = async () => true;
            broadbandReadiness.inspectIdentity = async () => ({ ready: true, errors: [] });
            broadbandReadiness.hierarchyErrors = () => [];

            const res = makeResponse();
            await servicesController.getPlansByIdentityId({ params: { serviceIdentityId: String(identityId) }, user: {} }, res);
            assert.deepStrictEqual(res.body.data.plans, []);
        });

        await test('unready AMOUNT identity fails canonical discovery', async () => {
            const identityId = new mongoose.Types.ObjectId();
            ServiceIdentity.findOne = () => chainResult({
                _id: identityId,
                name: 'Broadband Top-up',
                purchaseMode: 'amount',
                identifierPolicy: { label: 'Subscriber ID' },
                verificationPolicy: { mode: 'none' },
                amountPolicy: { min: 100, max: 10000, step: 100, currency: 'NGN' }
            });
            Service.find = () => chainResult([{
                _id: new mongoose.Types.ObjectId(), identityId, category: 'broadband', status: true
            }]);
            broadbandReadiness.isBroadbandIdentity = async () => true;
            broadbandReadiness.inspectIdentity = async () => ({ ready: true, errors: [] });
            broadbandReadiness.inspectService = async () => ({ ready: false, errors: ['No offer'] });

            const res = makeResponse();
            await servicesController.getPlansByIdentityId({ params: { serviceIdentityId: String(identityId) }, user: {} }, res);
            assert.strictEqual(res.statusCode, 409);
            assert.strictEqual(res.body.data, null);
        });

        await test('legacy plans endpoint rejects Broadband identity without querying plans', async () => {
            const identityId = new mongoose.Types.ObjectId();
            let serviceQueries = 0;
            ServiceIdentity.findById = async () => ({ _id: identityId, typeId: new mongoose.Types.ObjectId() });
            Service.find = () => {
                serviceQueries++;
                return chainResult([]);
            };
            broadbandReadiness.isBroadbandIdentity = async () => true;

            const res = makeResponse();
            await servicesController.getPlans({ params: { network: String(identityId) }, user: {} }, res);
            assert.strictEqual(res.statusCode, 409);
            assert.strictEqual(serviceQueries, 0);
            assert.strictEqual(String(res.body.data.serviceIdentityId), String(identityId));
        });
    } finally {
        ServiceIdentity.findOne = originals.identityFindOne;
        ServiceIdentity.findById = originals.identityFindById;
        Service.find = originals.serviceFind;
        procurementService.selectBestOffer = originals.selectBestOffer;
        pricingService.resolvePricing = originals.resolvePricing;
        broadbandReadiness.isBroadbandIdentity = originals.isBroadbandIdentity;
        broadbandReadiness.inspectIdentity = originals.inspectIdentity;
        broadbandReadiness.inspectService = originals.inspectService;
        broadbandReadiness.hierarchyErrors = originals.hierarchyErrors;
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
