/**
 * LEGAL COMPLIANCE — PHASE 2 TESTS
 *
 * Server-enforced signup legal acceptance + HTTP-428 action guard + minimal
 * SuperAdmin legal-document management endpoints and route-wiring integrity.
 *
 * Zero-dependency. Models are monkey-patched (repo test convention).
 * Run: node tests/legal_signup_and_guard.test.js
 */
const assert = require('assert');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-legal-jwt-secret';

const LegalDocument = require('../models/LegalDocument');
const LegalAcceptance = require('../models/LegalAcceptance');
const { computeHash } = require('../utils/legalHtml');
const legalService = require('../services/legalDocument.service');
const legalController = require('../controllers/legalDocumentController');
const auditController = require('../controllers/auditController');
const requireLegalCompliance = require('../middlewares/requireLegalCompliance');
const { verifyJWT, verifyJWTOptional, checkRoles } = require('../middlewares/auth');
const flutterwaveRouter = require('../routes/flutterwave');

// ---------------------------------------------------------------
// In-memory fake stores + query objects
// ---------------------------------------------------------------
let docs = [];
let accepts = [];
let idCounter = 1;

function q(value) {
    const query = {
        _sort: null,
        sort(key) { this._sort = key; return this; },
        limit() { return this; },
        skip() { return this; },
        lean() { return this; },
        session() { return this; },
        select() { return this; },
        then(res, rej) {
            let v = value;
            if (this._sort && Array.isArray(v)) {
                const [k, dir] = Object.entries(this._sort)[0];
                const cmp = (a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0);
                v = [...v].sort((a, b) => (dir < 0 ? cmp(b, a) : cmp(a, b)));
            }
            return Promise.resolve(v).then(res, rej);
        },
        catch(rej) { return Promise.resolve(value).catch(rej); },
        finally(fn) { return Promise.resolve(value).finally(fn); }
    };
    return query;
}

function matches(doc, filter) {
    if (!filter) return true;
    return Object.keys(filter).every((k) => {
        const want = filter[k];
        if (want && typeof want === 'object' && !(want instanceof Date) && '$in' in want) {
            return want.$in.includes(doc[k]);
        }
        return doc[k] === want;
    });
}

function qFindOne(computeMatches) {
    return {
        _sort: null,
        sort(key) { this._sort = key; return this; },
        lean() { return this; },
        session() { return this; },
        select() { return this; },
        then(res, rej) {
            let v = computeMatches();
            if (!v) return Promise.resolve(null).then(res, rej);
            if (this._sort && Array.isArray(v)) {
                const [k, dir] = Object.entries(this._sort)[0];
                const cmp = (a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0);
                v = [...v].sort((a, b) => (dir < 0 ? cmp(b, a) : cmp(a, b)));
            }
            const single = Array.isArray(v) ? (v[0] || null) : v;
            return Promise.resolve(single).then(res, rej);
        },
        catch(rej) { return Promise.resolve(computeMatches()).catch(rej); },
        finally(fn) { return Promise.resolve(computeMatches()).finally(fn); }
    };
}

function attachSave(doc) {
    doc.save = async () => doc;
    return doc;
}

function fakeSession() {
    return {
        startTransaction() {},
        commitTransaction: async () => {},
        abortTransaction: async () => {},
        endSession() {}
    };
}

function installMocks() {
    LegalDocument.find = (filter) => q(docs.filter(d => matches(d, filter)));
    LegalDocument.findOne = (filter) => qFindOne(() => docs.filter(d => matches(d, filter)));
    LegalDocument.findById = (id) => q(docs.find(d => String(d._id) === String(id)) || null);
    LegalDocument.create = async (data) => {
        const doc = attachSave({ _id: String(idCounter++), ...data, createdAt: new Date(), updatedAt: new Date() });
        docs.push(doc);
        return doc;
    };

    LegalAcceptance.find = (filter) => q(accepts.filter(a => matches(a, filter)));
    LegalAcceptance.findOne = (filter) => qFindOne(() => accepts.filter(a => matches(a, filter)));
    LegalAcceptance.create = async (data) => {
        const dup = accepts.find(a =>
            String(a.userId) === String(data.userId) &&
            a.documentType === data.documentType &&
            a.version === data.version);
        if (dup) {
            const e = new Error('duplicate key');
            e.code = 11000;
            throw e;
        }
        const rec = { _id: String(idCounter++), ...data, acceptedAt: new Date('2025-01-01T00:00:00Z') };
        accepts.push(rec);
        return rec;
    };

    mongoose.startSession = async () => fakeSession();
}

function resetStore() {
    docs = [];
    accepts = [];
    idCounter = 1;
}

function makeRes() {
    const res = {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; if (this.statusCode === null) this.statusCode = 200; return this; }
    };
    return res;
}

async function expectReject(fn) {
    try {
        await fn();
        return null;
    } catch (e) {
        return e;
    }
}

// ---------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------
const TOS_AGREE = {
    documentType: 'terms',
    title: 'Zantara Terms of Service',
    sourceMarkdown: '# Zantara Terms of Service\n\nBy using Zantara you agree to these terms.',
    acceptanceMode: 'agreement',
    requiresReacceptance: false
};
const PRIVACY_ACK = {
    documentType: 'privacy',
    title: 'Zantara Privacy Policy',
    sourceMarkdown: '# Zantara Privacy Policy\n\nWe process your data as described.',
    acceptanceMode: 'acknowledgement',
    requiresReacceptance: false
};
const REFUND_NONE = {
    documentType: 'refund_complaints',
    title: 'Zantara Refund, Reversal & Complaints Policy',
    sourceMarkdown: '# Refund Policy\n\nClaims are handled within 24 hours.',
    acceptanceMode: 'none',
    requiresReacceptance: false
};

// Publish a full baseline set: terms(agreement) + privacy(acknowledgement) + refund(none).
async function publishBaseline() {
    const t = await legalService.publish(
        (await legalService.createDraft({ ...TOS_AGREE, createdBy: 'A1' }))._id, { publishedBy: 'A1' });
    const p = await legalService.publish(
        (await legalService.createDraft({ ...PRIVACY_ACK, createdBy: 'A1' }))._id, { publishedBy: 'A1' });
    const r = await legalService.publish(
        (await legalService.createDraft({ ...REFUND_NONE, createdBy: 'A1' }))._id, { publishedBy: 'A1' });
    return { t, p, r };
}

const validPayload = (state) => {
    const byType = {};
    docs.filter(d => d.status === 'published').forEach(d => { byType[d.documentType] = d; });
    return [
        { documentType: 'terms', version: byType.terms.version, contentHash: computeHash(byType.terms.contentHtml), channel: 'web' },
        { documentType: 'privacy', version: byType.privacy.version, contentHash: computeHash(byType.privacy.contentHtml), channel: 'ios' }
    ];
};

// ---------------------------------------------------------------
// Runner
// ---------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
    try {
        fn();
        console.log(`  [PASS] ${name}`);
        passed++;
    } catch (err) {
        console.error(`  [FAIL] ${name}`);
        console.error(`         ${err.message}`);
        failures.push(`${name}: ${err.message}`);
        failed++;
    }
}

(async function run() {
    console.log('====================================================');
    console.log('     LEGAL COMPLIANCE — PHASE 2 TESTS');
    console.log('====================================================\n');

    installMocks();
    await publishBaseline();

    // ------------------------------------------------------------
    // A. Public serialization — 9 fields, never leaks internals
    // ------------------------------------------------------------
    console.log('--- A. serializeCurrent public shape ---');
    {
        const cur = await legalService.getCurrentByType('terms');
        const keys = Object.keys(cur);
        const expected = ['documentType', 'title', 'version', 'contentHtml', 'contentHash',
            'effectiveDate', 'acceptanceMode', 'requiresAcceptance', 'requiresReacceptance'];
        test('A1. exactly the 9 public fields are exposed', () => {
            assert.deepStrictEqual(keys.sort(), expected.sort());
        });
        test('A2. sourceMarkdown and internal publication fields never leak', () => {
            assert.ok(!('sourceMarkdown' in cur));
            assert.ok(!('publishedBy' in cur));
            assert.ok(!('createdBy' in cur));
            assert.ok(!('archivedAt' in cur));
            assert.ok(!('status' in cur));
        });
        test('A3. requiresAcceptance derives from acceptanceMode (terms -> true)', () => {
            assert.strictEqual(cur.requiresAcceptance, true);
        });
        const info = await legalService.getCurrentByType('refund_complaints');
        test('A4. informational (none) doc -> requiresAcceptance false', () => {
            assert.strictEqual(info.requiresAcceptance, false);
            assert.strictEqual(info.acceptanceMode, 'none');
        });
    }

    // ------------------------------------------------------------
    // B. Admin index endpoints — metadata only + full detail
    // ------------------------------------------------------------
    console.log('\n--- B. Admin getAll/getById ---');
    {
        const all = await legalService.getAllDocuments();
        test('B1. getAllDocuments returns metadata only (no sourceMarkdown/contentHtml)', () => {
            assert.strictEqual(all.length, 3);
            for (const item of all) {
                assert.ok(!('sourceMarkdown' in item));
                assert.ok(!('contentHtml' in item));
                assert.ok(item.id && item.status && item.documentType);
            }
        });
        const detail = await legalService.getDocumentById(all[0].id);
        test('B2. getDocumentById returns full doc incl sourceMarkdown for preview/edit', () => {
            assert.ok(detail.sourceMarkdown && detail.contentHtml);
        });
        const eMissing = await expectReject(() => legalService.getDocumentById('nope'));
        test('B3. getDocumentById unknown id -> 404 DOC_NOT_FOUND', () => {
            assert.strictEqual(eMissing.status, 404);
            assert.strictEqual(eMissing.code, 'DOC_NOT_FOUND');
        });
    }

    // ------------------------------------------------------------
    // C. validateSignupAcceptances — server-side signup enforcement
    // ------------------------------------------------------------
    console.log('\n--- C. validateSignupAcceptances (signup) ---');
    {
        const eEmpty = await expectReject(() => legalService.validateSignupAcceptances([]));
        test('C1. empty payload -> 400 LEGAL_ACCEPTANCE_REQUIRED', () => {
            assert.strictEqual(eEmpty.status, 400);
            assert.strictEqual(eEmpty.code, 'LEGAL_ACCEPTANCE_REQUIRED');
        });
        const eNoPayload = await expectReject(() => legalService.validateSignupAcceptances());
        test('C2. absent payload -> 400 LEGAL_ACCEPTANCE_REQUIRED', () => {
            assert.strictEqual(eNoPayload.status, 400);
            assert.strictEqual(eNoPayload.code, 'LEGAL_ACCEPTANCE_REQUIRED');
        });

        const termsOnly = validPayload().filter(i => i.documentType === 'terms');
        const eMissPrivacy = await expectReject(() => legalService.validateSignupAcceptances(termsOnly));
        test('C3. missing a required doc -> 400 with details.missing naming it', () => {
            assert.strictEqual(eMissPrivacy.status, 400);
            assert.strictEqual(eMissPrivacy.code, 'LEGAL_ACCEPTANCE_REQUIRED');
            assert.ok(eMissPrivacy.details.missing.includes('privacy'));
        });

        const payloadWithRandom = [...validPayload(), { documentType: 'cookies', version: 1, contentHash: 'x' }];
        const eBadType = await expectReject(() => legalService.validateSignupAcceptances(payloadWithRandom));
        test('C4. unknown documentType in payload -> 400 INVALID_DOCUMENT_TYPE', () => {
            assert.strictEqual(eBadType.status, 400);
            assert.strictEqual(eBadType.code, 'INVALID_DOCUMENT_TYPE');
        });

        const stale = [...validPayload()];
        stale[0] = { ...stale[0], version: 999 };
        const eStale = await expectReject(() => legalService.validateSignupAcceptances(stale));
        test('C5. stale version -> 409 STALE_VERSION', () => {
            assert.strictEqual(eStale.status, 409);
            assert.strictEqual(eStale.code, 'STALE_VERSION');
        });

        const badHash = [...validPayload()];
        badHash[1] = { ...badHash[1], contentHash: 'deadbeef' };
        const eHash = await expectReject(() => legalService.validateSignupAcceptances(badHash));
        test('C6. content hash mismatch -> 409 CONTENT_HASH_MISMATCH', () => {
            assert.strictEqual(eHash.status, 409);
            assert.strictEqual(eHash.code, 'CONTENT_HASH_MISMATCH');
        });

        const rows = await legalService.validateSignupAcceptances(validPayload());
        test('C7. valid payload -> normalized rows, server-derived documentId + acceptanceType', () => {
            assert.strictEqual(rows.length, 2);
            const terms = rows.find(r => r.documentType === 'terms');
            const privacy = rows.find(r => r.documentType === 'privacy');
            const publishedTerms = docs.find(d => d.documentType === 'terms' && d.status === 'published');
            const publishedPrivacy = docs.find(d => d.documentType === 'privacy' && d.status === 'published');
            assert.strictEqual(terms.documentId, publishedTerms._id);
            assert.strictEqual(privacy.documentId, publishedPrivacy._id);
            assert.strictEqual(terms.acceptanceType, 'agreement');
            assert.strictEqual(privacy.acceptanceType, 'acknowledgement');
        });

        const forged = validPayload().map(i => ({ ...i, documentId: 'FORGED', acceptanceType: 'acknowledgement' }));
        const rowsForged = await legalService.validateSignupAcceptances(forged);
        test('C8. client-supplied documentId/acceptanceType are never trusted', () => {
            for (const r of rowsForged) {
                assert.notStrictEqual(r.documentId, 'FORGED');
                assert.ok(r.documentId);
            }
            assert.strictEqual(rowsForged.find(r => r.documentType === 'terms').acceptanceType, 'agreement');
        });

        const overrideChannel = validPayload().map(i => ({ ...i, channel: 'quantum' }));
        const rowsChannel = await legalService.validateSignupAcceptances(overrideChannel);
        test('C9. unknown channel falls back to web', () => {
            assert.ok(rowsChannel.every(r => r.channel === 'web'));
        });

        const withInfo = validPayload().map(i => ({ ...i, channel: 'android' }));
        const infoAccepted = await legalService.validateSignupAcceptances([...withInfo,
            { documentType: 'refund_complaints', version: 1, contentHash: computeHash(docs.find(d => d.documentType === 'refund_complaints').contentHtml) }]);
        test('C10. informational (none) docs are not required and produce no row', () => {
            assert.strictEqual(infoAccepted.length, 2);
            assert.ok(!infoAccepted.some(r => r.documentType === 'refund_complaints'));
        });
    }

    // ------------------------------------------------------------
    // D. requireLegalCompliance (HTTP 428 guard)
    // ------------------------------------------------------------
    console.log('\n--- D. requireLegalCompliance ---');
    {
        const resNoUser = makeRes();
        await requireLegalCompliance({ user: null }, resNoUser, () => {});
        test('D1. no authenticated user -> 401', () => {
            assert.strictEqual(resNoUser.statusCode, 401);
        });

        const resBlocked = makeRes();
        await requireLegalCompliance({ user: { id: 'U_BLOCKED' } }, resBlocked, () => {});
        test('D2. missing acceptances -> 428 LEGAL_ACCEPTANCE_REQUIRED', () => {
            assert.strictEqual(resBlocked.statusCode, 428);
            assert.strictEqual(resBlocked.body.code, 'LEGAL_ACCEPTANCE_REQUIRED');
            assert.strictEqual(resBlocked.body.success, false);
        });
        test('D3. 428 payload carries outstanding required documents', () => {
            const required = resBlocked.body.data.requirements;
            const types = required.map(r => r.documentType).sort();
            assert.deepStrictEqual(types, ['privacy', 'terms']);
            assert.ok(required.every(r => r.acceptanceRequired === true));
        });

        // Full acceptance for current baseline -> guard passes.
        for (const doc of ['terms', 'privacy']) {
            await legalService.recordAcceptance({
                userId: 'U_CLEAN', documentType: doc,
                version: docs.find(d => d.documentType === doc && d.status === 'published').version,
                contentHash: computeHash(docs.find(d => d.documentType === doc && d.status === 'published').contentHtml),
                channel: 'web'
            });
        }
        let nextCalled = false;
        const resClean = makeRes();
        await requireLegalCompliance({ user: { id: 'U_CLEAN' } }, resClean, () => { nextCalled = true; });
        test('D4. compliant user passes through to next()', () => {
            assert.strictEqual(nextCalled, true);
            assert.strictEqual(resClean.statusCode, null);
        });

        // Material re-publish (requiresReacceptance true) of terms -> re-blocks a prior accepter.
        const materialV2 = await legalService.publish(
            (await legalService.createDraft({ ...TOS_AGREE, sourceMarkdown: '# v2 material', createdBy: 'A1', requiresReacceptance: true }))._id,
            { publishedBy: 'A1' });
        const resReaccept = makeRes();
        await requireLegalCompliance({ user: { id: 'U_CLEAN' } }, resReaccept, () => {});
        test('D5. material update -> 428 with outstanding terms (uses requirements, not frontend logic)', () => {
            assert.strictEqual(resReaccept.statusCode, 428);
            const types = resReaccept.body.data.requirements.map(r => r.documentType);
            assert.deepStrictEqual(types, ['terms']);
        });

        /** accept material v2 for U_CLEAN */
        await legalService.recordAcceptance({
            userId: 'U_CLEAN', documentType: 'terms', version: materialV2.version,
            contentHash: computeHash(materialV2.contentHtml), channel: 'web'
        });
        let next2 = false;
        const resResolved = makeRes();
        await requireLegalCompliance({ user: { id: 'U_CLEAN' } }, resResolved, () => { next2 = true; });
        test('D6. re-accepting the pending version unblocks 428', () => {
            assert.strictEqual(next2, true);
        });

        // Internal info doc (none) never causes a block.
        resetStore();
        await publishBaseline();
        const resInfoOnly = makeRes();
        await requireLegalCompliance({ user: { id: 'U_X' } }, resInfoOnly, () => {});
        test('D7. informational (none) doc ignored by the guard', () => {
            const types = resInfoOnly.body.data.requirements.map(r => r.documentType).sort();
            assert.deepStrictEqual(types, ['privacy', 'terms']);
            assert.ok(!types.includes('refund_complaints'));
        });
    }

    // ------------------------------------------------------------
    // E. SuperAdmin role guard
    // ------------------------------------------------------------
    console.log('\n--- E. checkRoles superAdmin ---');
    {
        const resNoRole = makeRes();
        checkRoles('superAdmin')({ user: { id: 'X', roles: ['user'] } }, resNoRole, () => {});
        test('E1. non-superAdmin -> 403', () => {
            assert.strictEqual(resNoRole.statusCode, 403);
        });
        const resRoleString = makeRes();
        let allowedString = false;
        checkRoles('superAdmin')({ user: { id: 'X', role: 'superAdmin' } }, resRoleString, () => { allowedString = true; });
        test('E2. role string superAdmin -> allowed', () => {
            assert.strictEqual(allowedString, true);
        });
        let allowed = false;
        checkRoles('superAdmin')({ user: { id: 'X', roles: ['user', 'superAdmin'] } }, makeRes(), () => { allowed = true; });
        test('E3. superAdmin in roles array -> allowed', () => {
            assert.strictEqual(allowed, true);
        });
        let allowed2 = false;
        checkRoles('admin', 'superAdmin')({ user: { id: 'X', role: 'admin' } }, makeRes(), () => { allowed2 = true; });
        test('E4. any allowed role passes', () => {
            assert.strictEqual(allowed2, true);
        });

        const resAdmin = makeRes();
        checkRoles('superAdmin')({ user: { id: 'X', role: 'admin' } }, resAdmin, () => {});
        test('E5. admin role is NOT a superAdmin — denied by legal admin gate', () => {
            assert.strictEqual(resAdmin.statusCode, 403);
        });
    }

    // ------------------------------------------------------------
    // F. Admin legal-management controller + audit logging
    // ------------------------------------------------------------
    console.log('\n--- F. Admin controller + audit ---');
    {
        const auditCalls = [];
        const originalLogAction = auditController.logAction;
        auditController.logAction = async (adminId, operatorName, action, target, details, result, req) => {
            auditCalls.push({ adminId, operatorName, action, target, details, result });
        };
        const adminReq = { user: { id: 'ADM_1', _id: 'ADM_1', name: 'Boss', email: 'a@z.com' } };

        const resList = makeRes();
        await legalController.adminListDocuments(adminReq, resList);
        test('F1. adminListDocuments -> metadata-only payload', () => {
            assert.strictEqual(resList.statusCode, 200);
            assert.strictEqual(resList.body.success, true);
            const first = resList.body.data[0];
            assert.ok(first.id && !('sourceMarkdown' in first) && !('contentHtml' in first));
        });

        const resCreate = makeRes();
        await legalController.adminCreateDraft({ ...adminReq, body: { ...TOS_AGREE, createdBy: 'ADM_1' } }, resCreate);
        test('F2. adminCreateDraft -> 200 + draft + audit LOG', () => {
            assert.strictEqual(resCreate.statusCode, 200);
            assert.strictEqual(resCreate.body.data.status, 'draft');
            const log = auditCalls.find(c => c.action === 'LEGAL_DOCUMENT_CREATED');
            assert.ok(log);
            assert.strictEqual(log.adminId, 'ADM_1');
            assert.strictEqual(log.operatorName, 'Boss');
            assert.strictEqual(log.result, 'success');
        });

        const newDraft = docs.find(d => d.status === 'draft' && d.documentType === 'terms');
        const resUpdate = makeRes();
        await legalController.adminUpdateDraft({ ...adminReq, params: { id: newDraft._id }, body: { changeSummary: 'Edition C' } }, resUpdate);
        test('F3. adminUpdateDraft -> 200 + audit LOG', () => {
            assert.strictEqual(resUpdate.body.data.changeSummary, 'Edition C');
            assert.ok(auditCalls.find(c => c.action === 'LEGAL_DOCUMENT_UPDATED'));
        });

        const resPublish = makeRes();
        await legalController.adminPublishDocument({ ...adminReq, params: { id: newDraft._id } }, resPublish);
        test('F4. adminPublishDocument -> 200 + version bump + audit LOG', () => {
            assert.strictEqual(resPublish.body.data.status, 'published');
            assert.strictEqual(resPublish.body.data.version, 2);
            const log = auditCalls.find(c => c.action === 'LEGAL_DOCUMENT_PUBLISHED');
            assert.ok(log);
            assert.strictEqual(log.details.acceptanceMode, 'agreement');
            assert.strictEqual(log.details.requiresReacceptance, false);
        });

        const resGet = makeRes();
        await legalController.adminGetDocument({ ...adminReq, params: { id: resPublish.body.data._id } }, resGet);
        test('F5. adminGetDocument -> full doc (preview/edit)', () => {
            assert.ok(resGet.body.data.sourceMarkdown);
            assert.ok(resGet.body.data.contentHash);
        });

        // Admin endpoints surface service errors with proper status + code.
        const resErr = makeRes();
        await legalController.adminGetDocument({ ...adminReq, params: { id: 'missing' } }, resErr);
        test('F6. admin error path -> 404 code surfaced', () => {
            assert.strictEqual(resErr.statusCode, 404);
            assert.strictEqual(resErr.body.code, 'DOC_NOT_FOUND');
        });

        auditController.logAction = originalLogAction;
    }

    resetStore();
    await publishBaseline();
    const signedToken = jwt.sign({ id: 'U_OPT', email: 'u@x.com', roles: ['user'] }, process.env.JWT_SECRET);

    // ------------------------------------------------------------
    // H. Optional auth for requirements — per-user vs anonymous
    // ------------------------------------------------------------
    console.log('\n--- H. verifyJWTOptional + per-user requirements ---');
    {
        const userReq = { headers: { authorization: `Bearer ${signedToken}` } };
        const userNext = () => { userReq.__next = true; };
        verifyJWTOptional(userReq, makeRes(), userNext);
        test('H1. valid token -> req.user.id matches payload id', () => {
            assert.strictEqual(userReq.user.id, 'U_OPT');
            assert.ok(userReq.__next);
        });

        const anonReq = { headers: {} };
        verifyJWTOptional(anonReq, makeRes(), () => {});
        test('H2. no token -> anonymous, next() still called (never blocked)', () => {
            assert.strictEqual(anonReq.user, undefined);
        });

        const badReq = { headers: { authorization: 'Bearer not.a.jwt' } };
        const badRes = makeRes();
        let badNext = false;
        verifyJWTOptional(badReq, badRes, () => { badNext = true; });
        test('H3. invalid token -> anonymous fallback, no error response', () => {
            assert.strictEqual(badReq.user, undefined);
            assert.strictEqual(badRes.statusCode, null);
            assert.strictEqual(badNext, true);
        });

        // Controller-level per-user state: authenticated -> cleared after acceptance;
        // anonymous -> always shows the full signup-required set.
        const resAnon = makeRes();
        await legalController.getRequirements({}, resAnon);
        test('H4. requirements controller (anonymous) -> terms+privacy missing, refund never', () => {
            assert.strictEqual(resAnon.statusCode, 200);
            const missing = (resAnon.body.data.missingAcceptances || []).sort();
            assert.deepStrictEqual(missing, ['privacy', 'terms']);
        });

        await legalService.recordAcceptance({
            userId: 'U_OPT', documentType: 'terms',
            version: docs.find(d => d.documentType === 'terms' && d.status === 'published').version,
            contentHash: computeHash(docs.find(d => d.documentType === 'terms' && d.status === 'published').contentHtml),
            channel: 'web'
        });
        const resAuthed = makeRes();
        await legalController.getRequirements({ user: { id: 'U_OPT' } }, resAuthed);
        test('H5. requirements controller (authenticated) -> only unmatched docs missing', () => {
            const missing = resAuthed.body.data.missingAcceptances;
            assert.deepStrictEqual(missing, ['privacy']);
        });
    }

    // ------------------------------------------------------------
    // I. Route-wiring integrity (guarded vs unguarded)
    // ------------------------------------------------------------
    console.log('\n--- I. Route-wiring integrity ---');
    const legalRouter = require('../routes/legal');
    const servicesRouter = require('../routes/services');
    const walletRouter = require('../routes/wallet');
    const investmentRouter = require('../routes/investment');
    const withdrawalRouter = require('../routes/withdrawal');

    const layersFor = (router, path) => {
        const layer = router.stack.find(l => l.route && l.route.path === path);
        if (!layer) return null;
        return layer.route.stack.map(s => s.handle);
    };
    const has = (handles, fn) => handles.some(h => h === fn);

    test('G1. legal public routes are unauthenticated + unguarded', () => {
        for (const path of ['/documents', '/documents/current', '/documents/:type/current']) {
            const h = layersFor(legalRouter, path);
            assert.ok(h && h.length === 1, `${path} should have a single handler`);
            assert.ok(!has(h, verifyJWT) && !has(h, requireLegalCompliance), `${path} must not be guarded`);
        }
    });
    test('G1b. /requirements uses optional auth — per-user when token present, never blocked', () => {
        const h = layersFor(legalRouter, '/requirements');
        assert.ok(h && h[0] === verifyJWTOptional, '/requirements must start with verifyJWTOptional');
        assert.ok(!has(h, verifyJWT), '/requirements must not hard-require auth');
        assert.ok(!has(h, requireLegalCompliance), '/requirements must never be compliance-blocked');
    });
    test('G2. legal user routes: JWT-protected but NOT legal-guarded', () => {
        const acc = layersFor(legalRouter, '/acceptance');
        const mine = layersFor(legalRouter, '/acceptance/mine');
        assert.ok(acc[0] === verifyJWT && !has(acc, requireLegalCompliance));
        assert.ok(mine[0] === verifyJWT && !has(mine, requireLegalCompliance));
    });
    test('G3. legal admin routes: JWT + role gate, still not legal-guarded', () => {
        const admin = layersFor(legalRouter, '/admin/documents');
        assert.ok(admin && admin[0] === verifyJWT);
        assert.ok(admin.length === 3, 'expected verifyJWT + checkRoles + handler');
        assert.ok(!has(admin, requireLegalCompliance));
    });
    test('G4. guarded: POST /services/airtime,data,electricity,cable,purchase-pin', () => {
        for (const path of ['/airtime', '/data', '/electricity', '/cable', '/purchase-pin']) {
            const h = layersFor(servicesRouter, path);
            assert.ok(h[0] === verifyJWT, `${path} first layer must be verifyJWT`);
            assert.ok(h[1] === requireLegalCompliance, `${path} second layer must be the legal guard`);
        }
    });
    test('G5. guarded: POST /wallet/debit,credit,transfer,redeem-earnings,fund', () => {
        for (const path of ['/debit', '/credit', '/transfer', '/redeem-earnings', '/fund']) {
            const h = layersFor(walletRouter, path);
            assert.ok(h[0] === verifyJWT && h[1] === requireLegalCompliance, `${path} mis-wired`);
        }
    });
    test('G6. guarded: POST /investment/buy,exit,reinvest,redeem,withdraw', () => {
        for (const path of ['/buy', '/exit', '/reinvest', '/redeem', '/withdraw']) {
            const h = layersFor(investmentRouter, path);
            assert.ok(h[0] === verifyJWT && h[1] === requireLegalCompliance, `${path} mis-wired`);
        }
    });
    test('G7. guarded: POST /withdrawal (root)', () => {
        const h = layersFor(withdrawalRouter, '/');
        assert.ok(h[0] === verifyJWT && h[1] === requireLegalCompliance, 'withdrawal mis-wired');
    });
    test('G8. guarded: POST /flutterwave/initialize (wallet funding initiation)', () => {
        const h = layersFor(flutterwaveRouter, '/initialize');
        assert.ok(h && h[0] === verifyJWT && h[1] === requireLegalCompliance,
            '/flutterwave/initialize must be verifyJWT + requireLegalCompliance + handler');
        assert.strictEqual(h.length, 3, 'expected verifyJWT + requireLegalCompliance + handler');
    });

    // ------------------------------------------------------------
    // J. Flutterwave initialize — 428 when non-compliant, unchanged when compliant
    // ------------------------------------------------------------
    console.log('\n--- J. Flutterwave initialize guard behavior ---');
    {
        // Stub the HTTP layer the real handler reaches (axios.post), so the
        // compliant path exercises the true flutterwaveController.payment() +
        // utils/flutterwave.initializePayment() end to end without a network call.
        const axios = require('axios');
        const originalPost = axios.post;
        let gatewayCalls = 0;
        axios.post = async (url, body, config) => {
            gatewayCalls++;
            return {
                data: {
                    status: 'success',
                    data: { link: 'https://checkout.flutterwave.com/flw-ok' }
                }
            };
        };
        const flwController = require('../controllers/flutterwaveController');

        resetStore();
        await publishBaseline();

        // Non-compliant user: blocked at the guard, gateway never contacted.
        const blockedReq = { user: { id: 'U_FLW_BAD', email: 'bad@x.com' } };
        const blockedRes = makeRes();
        let blockedNext = false;
        await requireLegalCompliance(blockedReq, blockedRes, () => { blockedNext = true; });
        test('J1. non-compliant user -> 428 LEGAL_ACCEPTANCE_REQUIRED (never reaches gateway)', () => {
            assert.strictEqual(blockedRes.statusCode, 428);
            assert.strictEqual(blockedRes.body.code, 'LEGAL_ACCEPTANCE_REQUIRED');
            assert.ok(!blockedNext);
            assert.strictEqual(gatewayCalls, 0);
        });

        // Compliant user: full chain + real handler -> gateway initialized as before.
        await legalService.recordAcceptance({
            userId: 'U_FLW_OK', documentType: 'terms',
            version: docs.find(d => d.documentType === 'terms' && d.status === 'published').version,
            contentHash: computeHash(docs.find(d => d.documentType === 'terms' && d.status === 'published').contentHtml),
            channel: 'web'
        });
        await legalService.recordAcceptance({
            userId: 'U_FLW_OK', documentType: 'privacy',
            version: docs.find(d => d.documentType === 'privacy' && d.status === 'published').version,
            contentHash: computeHash(docs.find(d => d.documentType === 'privacy' && d.status === 'published').contentHtml),
            channel: 'web'
        });
        const okReq = { user: { id: 'U_FLW_OK', email: 'ok@x.com' }, body: { amount: 2000 } };
        const okRes = makeRes();
        let okNext = false;
        await requireLegalCompliance(okReq, okRes, () => { okNext = true; });
        test('J2. compliant user passes the guard -> next()', () => {
            assert.strictEqual(okNext, true);
            assert.strictEqual(okRes.statusCode, null);
        });
        if (okNext) {
            await flwController.payment(okReq, okRes);
        }
        test('J3. gateway behavior unchanged after compliance: payment() initializes + responds', () => {
            assert.strictEqual(gatewayCalls, 1);
            assert.strictEqual(okRes.statusCode, 200);
            assert.ok(okRes.body.authorization_url.includes('checkout.flutterwave.com'));
            assert.ok(okRes.body.reference);
        });

        axios.post = originalPost;
    }

    console.log('\n====================================================');
    console.log(`  RESULT: ${passed} passed, ${failed} failed`);
    if (failures.length) {
        console.log('  Failures:');
        failures.forEach(f => console.log(`    - ${f}`));
    }
    console.log('====================================================');
    process.exit(failed ? 1 : 0);
})().catch(err => {
    console.error('Test suite crashed:', err);
    process.exit(1);
});