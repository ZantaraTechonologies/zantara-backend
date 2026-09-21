/**
 * LEGAL DOCUMENTS — PHASE 1 CORE TESTS
 *
 * Versioned legal documents lifecycle: markdown -> sanitized HTML + SHA-256,
 * draft/publish/archive, exactly-one-published, acceptanceMode derivation,
 * requiresReacceptance polling semantics, idempotent acceptance recording,
 * and requirements reporting for anonymous vs authenticated users.
 *
 * Zero-dependency. Models are monkey-patched (repo test convention).
 * Run: node tests/legal_documents.test.js
 */
const assert = require('assert');
const mongoose = require('mongoose');

const LegalDocument = require('../models/LegalDocument');
const LegalAcceptance = require('../models/LegalAcceptance');
const { markdownToHtml, sanitizeHtml, computeHash, verifyHash } = require('../utils/legalHtml');
const legalService = require('../services/legalDocument.service');
const legalController = require('../controllers/legalDocumentController');
const requireLegalCompliance = require('../middlewares/requireLegalCompliance');
const { getMissingApprovedContent } = require('../scripts/seed_legal_documents');

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
        // Real 24-hex ObjectIds so production id validation is exercised faithfully.
        const doc = attachSave({ _id: new mongoose.Types.ObjectId().toString(), ...data, createdAt: new Date(), updatedAt: new Date() });
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

const TOS_AGREE = {
    documentType: 'terms',
    title: 'Terms of Service',
    sourceMarkdown: '# Zantara Terms of Service\n\nBy using Zantara you agree to these terms.',
    acceptanceMode: 'agreement',
    requiresReacceptance: false
};
const PRIVACY_ACK = {
    documentType: 'privacy',
    title: 'Privacy Policy',
    sourceMarkdown: '# Zantara Privacy Policy\n\nWe process your data as described.',
    acceptanceMode: 'acknowledgement',
    requiresReacceptance: false
};
const REFUND_NONE = {
    documentType: 'refund_complaints',
    title: 'Refund, Reversal & Complaints Policy',
    sourceMarkdown: '# Refund, Reversal & Complaints Policy\n\nClaims are handled within 24 hours.',
    acceptanceMode: 'none',
    requiresReacceptance: false
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
    console.log('     LEGAL DOCUMENTS — PHASE 1 CORE TESTS');
    console.log('====================================================\n');

    installMocks();

    // ------------------------------------------------------------
    // A. Markdown / sanitization / hashing
    // ------------------------------------------------------------
    console.log('--- A. Markdown, sanitization, hashing ---');
    test('A1. markdownToHtml renders markdown heading', () => {
        const html = markdownToHtml('# Zantara Terms');
        assert.ok(html.includes('<h1'));
        assert.ok(html.includes('Zantara Terms'));
    });
    test('A2. sanitizeHtml strips <script>, onclick, javascript: links', () => {
        const out = sanitizeHtml('<p onclick="alert(1)">hi<script>alert(1)</script></p><a href="javascript:alert(1)">x</a>');
        assert.ok(!out.toLowerCase().includes('script'));
        assert.ok(!out.toLowerCase().includes('onclick'));
        assert.ok(!out.toLowerCase().includes('javascript:'));
    });
    test('A3. computeHash is deterministic, 64-hex Sha256', () => {
        assert.strictEqual(computeHash('<p>same</p>'), computeHash('<p>same</p>'));
        assert.match(computeHash('<p>same</p>'), /^[a-f0-9]{64}$/);
    });
    test('A4. computeHash differs, trims content, verifyHash roundtrip', () => {
        assert.notStrictEqual(computeHash('a'), computeHash('b'));
        assert.strictEqual(computeHash('  <p>x</p>  '), computeHash('<p>x</p>'));
        assert.strictEqual(verifyHash({ contentHash: computeHash('<p>x</p>') }, '<p>x</p>'), true);
        assert.strictEqual(verifyHash({ contentHash: computeHash('<p>x</p>') }, '<p>y</p>'), false);
    });
    test('A5. links rewritten with rel=noopener noreferrer nofollow target=_blank', () => {
        const out = markdownToHtml('[terms](https://example.com)');
        assert.ok(out.includes('rel="noopener noreferrer nofollow"'));
        assert.ok(out.includes('target="_blank"'));
    });

    // ------------------------------------------------------------
    // B. Model constants and derived flags
    // ------------------------------------------------------------
    console.log('\n--- B. Model constants & derived flags ---');
    test('B1. DOCUMENT_TYPES and ACCEPTANCE_MODES exported', () => {
        assert.deepStrictEqual([...LegalDocument.DOCUMENT_TYPES].sort(), ['aml_kyc', 'privacy', 'refund_complaints', 'terms']);
        assert.deepStrictEqual([...LegalDocument.ACCEPTANCE_MODES].sort(), ['acknowledgement', 'agreement', 'none']);
    });
    test('B2. requiresAcceptance virtual + requiresReacceptance default', () => {
        const agree = new LegalDocument({ ...TOS_AGREE, createdBy: '5f0000000000000000000001' });
        assert.strictEqual(agree.requiresAcceptance, true);
        assert.strictEqual(agree.requiresReacceptance, false);
        const info = new LegalDocument({ ...REFUND_NONE, createdBy: '5f0000000000000000000001' });
        assert.strictEqual(info.requiresAcceptance, false);
        assert.strictEqual(info.requiresReacceptance, false);
    });

    // ------------------------------------------------------------
    // C. Draft lifecycle
    // ------------------------------------------------------------
    console.log('\n--- C. Draft lifecycle ---');
    resetStore();

    const eNoActor = await expectReject(() => legalService.createDraft({ ...TOS_AGREE }));
    test('C1. createDraft without createdBy -> 400', () => assert.strictEqual(eNoActor.status, 400));
    const eUnknownType = await expectReject(() => legalService.createDraft({ ...TOS_AGREE, createdBy: 'A1', documentType: 'cookies' }));
    test('C2. createDraft unknown type -> 400', () => assert.strictEqual(eUnknownType.status, 400));
    const eBadMode = await expectReject(() => legalService.createDraft({ ...TOS_AGREE, createdBy: 'A1', acceptanceMode: 'bogus' }));
    test('C2b. createDraft invalid acceptanceMode -> 400', () => assert.strictEqual(eBadMode.status, 400));

    const draft = await legalService.createDraft({ ...TOS_AGREE, createdBy: 'A1' });
    test('C3. draft has version null, status draft, sanitized contentHtml', () => {
        assert.strictEqual(draft.status, 'draft');
        assert.strictEqual(draft.version, null);
        assert.ok(draft.sourceMarkdown.includes('Zantara'));
        assert.ok(draft.contentHtml.includes('<h1'));
    });

    await legalService.updateDraft(draft._id, {
        sourceMarkdown: '# Zantara Terms of Service (edition B)\n\nUpdated line here.',
        changeSummary: 'Edition B'
    });
    test('C4. updateDraft re-renders contentHtml, version stays null', () => {
        const doc = docs.find(d => d._id === draft._id);
        assert.ok(doc.contentHtml.includes('edition B'));
        assert.strictEqual(doc.version, null);
        assert.strictEqual(doc.changeSummary, 'Edition B');
    });

    const titleUpdated = await legalService.updateDraft(draft._id, { title: 'Terms of Service', changeSummary: 'Still editable' });
    test('C5. updateDraft on a draft succeeds (editable)', () => {
        assert.strictEqual(titleUpdated.title, 'Terms of Service');
        assert.strictEqual(titleUpdated.changeSummary, 'Still editable');
    });

    // ------------------------------------------------------------
    // D. Publish lifecycle (transactional, exactly-one-published)
    // ------------------------------------------------------------
    console.log('\n--- D. Publish lifecycle ---');
    const pub1 = await legalService.publish(draft._id, { publishedBy: 'A1' });
    test('D1. first publish -> version 1, published, contentHash set', () => {
        assert.strictEqual(pub1.status, 'published');
        assert.strictEqual(pub1.version, 1);
        assert.strictEqual(pub1.contentHash, computeHash(pub1.contentHtml));
        assert.ok(pub1.publishedAt);
        assert.strictEqual(pub1.publishedBy, 'A1');
    });

    const eEditPublished = await expectReject(() => legalService.updateDraft(pub1._id, { title: 'Hacked' }));
    test('D2. published document is immutable via updateDraft -> 409', () => {
        assert.strictEqual(eEditPublished.status, 409);
    });

    const eRepublish = await expectReject(() => legalService.publish(pub1._id, { publishedBy: 'A1' }));
    test('D3. re-publishing a published doc -> 409', () => {
        assert.strictEqual(eRepublish.status, 409);
    });

    const draft2 = await legalService.createDraft({ ...TOS_AGREE, createdBy: 'A1' });
    const pub2 = await legalService.publish(draft2._id, { publishedBy: 'A1' });
    test('D4. second publish -> v2, prior archived, exactly one published', () => {
        assert.strictEqual(pub2.version, 2);
        const published = docs.filter(d => d.documentType === 'terms' && d.status === 'published');
        const archived = docs.filter(d => d.documentType === 'terms' && d.status === 'archived');
        assert.strictEqual(published.length, 1);
        assert.strictEqual(published[0]._id, pub2._id);
        assert.strictEqual(archived.length, 1);
        assert.strictEqual(archived[0]._id, pub1._id);
        assert.ok(pub1.archivedAt);
    });
    test('D5. publish assigns version = max(published|archived)+1', () => {
        const maxV = Math.max(...docs.filter(d => d.documentType === 'terms').map(d => d.version || 0));
        assert.strictEqual(pub2.version, maxV);
    });

    // ------------------------------------------------------------
    // E. Archive protection
    // ------------------------------------------------------------
    console.log('\n--- E. Archive protection ---');
    const eArchiveMandatory = await expectReject(() => legalService.archive(pub2._id));
    test('E1. standalone archive of mandatory (agreement) published -> 409', () => {
        assert.strictEqual(eArchiveMandatory.status, 409);
        assert.strictEqual(eArchiveMandatory.code, 'MANDATORY_DOCUMENT');
    });

    const pDraft = await legalService.createDraft({ ...REFUND_NONE, createdBy: 'A1' });
    const pPub = await legalService.publish(pDraft._id, { publishedBy: 'A1' });
    const archivedInfo = await legalService.archive(pPub._id);
    test('E2. informational (none) published can be archived standalone', () => {
        assert.strictEqual(archivedInfo.status, 'archived');
        assert.ok(archivedInfo.archivedAt);
    });

    // ------------------------------------------------------------
    // F. getRequirements semantics (anonymous + authenticated)
    // ------------------------------------------------------------
    console.log('\n--- F. getRequirements semantics ---');
    resetStore();
    const t1 = await legalService.publish((await legalService.createDraft({ ...TOS_AGREE, createdBy: 'A1' }))._id, { publishedBy: 'A1' });
    await legalService.publish((await legalService.createDraft({ ...PRIVACY_ACK, createdBy: 'A1' }))._id, { publishedBy: 'A1' });
    const r1 = await legalService.publish((await legalService.createDraft({ ...REFUND_NONE, createdBy: 'A1' }))._id, { publishedBy: 'A1' });

    const anon = await legalService.getRequirements({});
    test('F1. anonymous -> only docs with acceptanceMode != none are required', () => {
        assert.strictEqual(anon.documents.length, 3);
        const terms = anon.documents.find(d => d.documentType === 'terms');
        const privacy = anon.documents.find(d => d.documentType === 'privacy');
        const refund = anon.documents.find(d => d.documentType === 'refund_complaints');
        assert.strictEqual(terms.acceptanceRequired, true);
        assert.strictEqual(refund.acceptanceRequired, false);
        assert.strictEqual(privacy.acceptanceRequired, true);
        assert.strictEqual(refund.pendingReacceptance, false);
    });

    const USER = 'U_1';
    const authed = await legalService.getRequirements({ userId: USER });
    test('F2. authed who never accepted -> same as anonymous + missingAcceptances', () => {
        assert.deepStrictEqual(authed.missingAcceptances.sort(), ['privacy', 'terms']);
        assert.strictEqual(authed.pendingReacceptance, false);
    });

    await legalService.recordAcceptance({
        userId: USER, documentType: 'terms', version: t1.version,
        contentHash: computeHash(t1.contentHtml), channel: 'web'
    });
    const afterAccept = await legalService.getRequirements({ userId: USER });
    test('F3. accepted current version -> terms not required, acceptedVersion preserved', () => {
        const terms = afterAccept.documents.find(d => d.documentType === 'terms');
        assert.strictEqual(terms.acceptanceRequired, false);
        assert.strictEqual(terms.acceptance.accepted, true);
        assert.strictEqual(terms.acceptance.acceptedVersion, t1.version);
        assert.deepStrictEqual(afterAccept.missingAcceptances, ['privacy']);
    });

    const t2 = await legalService.publish((await legalService.createDraft({ ...TOS_AGREE, createdBy: 'A1', requiresReacceptance: false }))._id, { publishedBy: 'A1' });
    const afterMinor = await legalService.getRequirements({ userId: USER });
    test('F4. newer version without requiresReacceptance -> prior acceptance stands', () => {
        const terms = afterMinor.documents.find(d => d.documentType === 'terms');
        assert.strictEqual(terms.version, t2.version);
        assert.strictEqual(terms.acceptanceRequired, false);
        assert.strictEqual(terms.pendingReacceptance, false);
        assert.strictEqual(terms.acceptance.acceptedVersion, t1.version);
    });

    const t3 = await legalService.publish((await legalService.createDraft({ ...TOS_AGREE, createdBy: 'A1', requiresReacceptance: true }))._id, { publishedBy: 'A1' });
    const afterMaterial = await legalService.getRequirements({ userId: USER });
    test('F5. newer version with requiresReacceptance -> pendingReacceptance', () => {
        const terms = afterMaterial.documents.find(d => d.documentType === 'terms');
        assert.strictEqual(terms.version, t3.version);
        assert.strictEqual(terms.acceptanceRequired, true);
        assert.strictEqual(terms.pendingReacceptance, true);
        assert.strictEqual(terms.acceptance.acceptedVersion, t1.version);
        assert.strictEqual(afterMaterial.pendingReacceptance, true);
        assert.ok(afterMaterial.missingAcceptances.includes('terms'));
    });

    await legalService.recordAcceptance({
        userId: USER, documentType: 'terms', version: t3.version,
        contentHash: computeHash(t3.contentHtml), channel: 'web'
    });
    const afterResolve = await legalService.getRequirements({ userId: USER });
    test('F6. accepting pending version resolves pendingReacceptance', () => {
        const terms = afterResolve.documents.find(d => d.documentType === 'terms');
        assert.strictEqual(terms.acceptanceRequired, false);
        assert.strictEqual(terms.pendingReacceptance, false);
        assert.strictEqual(afterResolve.pendingReacceptance, false);
    });
    void r1;

    // ------------------------------------------------------------
    // G. recordAcceptance guards & derivation
    // ------------------------------------------------------------
    console.log('\n--- G. recordAcceptance guards & derivation ---');
    resetStore();
    const gt1 = await legalService.publish((await legalService.createDraft({ ...TOS_AGREE, createdBy: 'A1' }))._id, { publishedBy: 'A1' });
    const gp1 = await legalService.publish((await legalService.createDraft({ ...REFUND_NONE, createdBy: 'A1' }))._id, { publishedBy: 'A1' });

    const eUnknownDoc = await expectReject(() => legalService.recordAcceptance({ userId: 'U_1', documentType: 'cookies', version: 1, contentHash: 'x' }));
    test('G1. unknown document type -> 404 DOCUMENT_TYPE_UNKNOWN', () => {
        assert.strictEqual(eUnknownDoc.status, 404);
        assert.strictEqual(eUnknownDoc.code, 'DOCUMENT_TYPE_UNKNOWN');
    });

    const eNoneMode = await expectReject(() => legalService.recordAcceptance({
        userId: 'U_1', documentType: 'refund_complaints', version: gp1.version,
        contentHash: computeHash(gp1.contentHtml), channel: 'web'
    }));
    test('G2. acceptanceMode none -> 400 ACCEPTANCE_NOT_REQUIRED', () => {
        assert.strictEqual(eNoneMode.status, 400);
        assert.strictEqual(eNoneMode.code, 'ACCEPTANCE_NOT_REQUIRED');
    });

    const eStale = await expectReject(() => legalService.recordAcceptance({
        userId: 'U_1', documentType: 'terms', version: 999,
        contentHash: computeHash(gt1.contentHtml), channel: 'web'
    }));
    test('G3. stale version -> 409 STALE_VERSION', () => {
        assert.strictEqual(eStale.status, 409);
        assert.strictEqual(eStale.code, 'STALE_VERSION');
    });

    const eBadHash = await expectReject(() => legalService.recordAcceptance({
        userId: 'U_1', documentType: 'terms', version: gt1.version,
        contentHash: 'deadbeef', channel: 'web'
    }));
    test('G4. content hash mismatch -> 409 CONTENT_HASH_MISMATCH', () => {
        assert.strictEqual(eBadHash.status, 409);
        assert.strictEqual(eBadHash.code, 'CONTENT_HASH_MISMATCH');
    });

    const rec = await legalService.recordAcceptance({
        userId: 'U_1', documentType: 'terms', version: gt1.version,
        contentHash: computeHash(gt1.contentHtml), channel: 'android', ipAddress: '127.0.0.1', userAgent: 't'
    });
    test('G5. acceptanceType is derived from document (agreement), never from client body', () => {
        assert.strictEqual(rec.acceptanceType, 'agreement');
        assert.strictEqual(rec.version, gt1.version);
        assert.strictEqual(rec.channel, 'android');
        assert.strictEqual(rec.contentHash, computeHash(gt1.contentHtml));
    });

    const rec2 = await legalService.recordAcceptance({
        userId: 'U_1', documentType: 'terms', version: gt1.version,
        contentHash: computeHash(gt1.contentHtml), channel: 'web'
    });
    test('G6. duplicate acceptance is idempotent -> same record returned, one row only', () => {
        assert.strictEqual(rec2._id, rec._id);
        assert.strictEqual(accepts.filter(a => a.documentType === 'terms' && a.userId === 'U_1').length, 1);
    });

    resetStore();
    const gr1 = await legalService.publish((await legalService.createDraft({ ...PRIVACY_ACK, createdBy: 'A1' }))._id, { publishedBy: 'A1' });
    const ack = await legalService.recordAcceptance({
        userId: 'U_2', documentType: 'privacy', version: gr1.version,
        contentHash: computeHash(gr1.contentHtml), channel: 'web'
    });
    test('G7. acknowledgement mode derives acceptanceType "acknowledgement"', () => {
        assert.strictEqual(ack.acceptanceType, 'acknowledgement');
    });

    // ------------------------------------------------------------
    // H. Controller / endpoints
    // ------------------------------------------------------------
    console.log('\n--- H. Controller endpoints ---');
    resetStore();
    await legalService.publish((await legalService.createDraft({ ...TOS_AGREE, createdBy: 'A1' }))._id, { publishedBy: 'A1' });

    {
        const res = makeRes();
        await legalController.getCurrentByType({ params: { type: 'cookies' } }, res);
        test('H1. GET /documents/:type/current unknown type -> 404 DOCUMENT_TYPE_UNKNOWN', () => {
            assert.strictEqual(res.statusCode, 404);
            assert.strictEqual(res.body.code, 'DOCUMENT_TYPE_UNKNOWN');
        });
    }
    {
        const res = makeRes();
        await legalController.getPublicDocuments({}, res);
        test('H2. GET /documents/current -> published overview shape', () => {
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.data.length, 1);
            assert.strictEqual(res.body.data[0].documentType, 'terms');
            assert.ok(res.body.data[0].contentHash);
            assert.ok('acceptanceMode' in res.body.data[0]);
        });
    }
    {
        const res = makeRes();
        const reqAccept = {
            user: { id: 'U_H1' },
            body: { documentType: 'terms', version: 1, contentHash: computeHash(docs.find(d => d.documentType === 'terms').contentHtml), channel: 'web', acceptanceType: 'acknowledgement' },
            ip: '10.0.0.1',
            headers: { 'user-agent': 't' }
        };
        await legalController.acceptDocument(reqAccept, res);
        test('H3. POST /acceptance ignores client acceptanceType, returns requirements', () => {
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.record.acceptanceType, 'agreement');
            assert.strictEqual(res.body.data.requirements.documents[0].acceptanceRequired, false);
        });
    }
    {
        let lastFilter = null;
        LegalAcceptance.find = (filter) => { lastFilter = filter; return q([]); };
        const res = makeRes();
        await legalController.getMyAcceptances({ user: { id: 'U_MINE' } }, res);
        test('H4. GET /acceptance/mine is scoped to req.user.id', () => {
            assert.strictEqual(lastFilter.userId, 'U_MINE');
            assert.strictEqual(res.statusCode, 200);
        });
    }

    // ------------------------------------------------------------
    // I. Item 32 canonical policy and AML/KYC isolation
    // ------------------------------------------------------------
    console.log('\n--- I. Item 32 canonical policy and AML/KYC isolation ---');
    resetStore();

    test('I32-1. one canonical map defines exactly the four required policies', () => {
        assert.deepStrictEqual(LegalDocument.DOCUMENT_POLICIES, {
            terms: { displayName: 'Terms of Service', isPublic: true, acceptanceMode: 'agreement' },
            privacy: { displayName: 'Privacy Policy', isPublic: true, acceptanceMode: 'acknowledgement' },
            refund_complaints: { displayName: 'Refund, Reversal & Complaints Policy', isPublic: true, acceptanceMode: 'none' },
            aml_kyc: { displayName: 'AML/KYC, Fraud Prevention & Acceptable Use Framework', isPublic: false, acceptanceMode: 'none' }
        });
    });
    test('I32-2. public and mandatory type lists are derived with AML and refund excluded as required', () => {
        assert.deepStrictEqual([...LegalDocument.PUBLIC_DOCUMENT_TYPES].sort(), ['privacy', 'refund_complaints', 'terms']);
        assert.deepStrictEqual([...LegalDocument.MANDATORY_DOCUMENT_TYPES].sort(), ['privacy', 'terms']);
    });
    test('I32-3. existing semantic fields and derived requiresAcceptance virtual remain', () => {
        assert.ok(LegalDocument.schema.path('isPublic'));
        assert.ok(LegalDocument.schema.path('acceptanceMode'));
        assert.ok(LegalDocument.schema.virtualpath('requiresAcceptance'));
        const aml = new LegalDocument({ documentType: 'aml_kyc', title: 'x', contentHtml: '<p>x</p>', createdBy: '5f0000000000000000000001' });
        assert.strictEqual(aml.requiresAcceptance, false);
    });

    const amlDraft = await legalService.createDraft({
        documentType: 'aml_kyc',
        title: 'AML/KYC, Fraud Prevention & Acceptable Use Framework',
        sourceMarkdown: '# Internal framework',
        acceptanceMode: 'none',
        isPublic: false,
        createdBy: 'A1'
    });
    test('I32-4. AML draft initial insert is canonical and never temporarily public', () => {
        assert.strictEqual(amlDraft.title, LegalDocument.DOCUMENT_POLICIES.aml_kyc.displayName);
        assert.strictEqual(amlDraft.isPublic, false);
        assert.strictEqual(amlDraft.acceptanceMode, 'none');
        assert.strictEqual(amlDraft.status, 'draft');
    });

    const createOverride = await expectReject(() => legalService.createDraft({
        documentType: 'aml_kyc',
        title: 'AML/KYC, Fraud Prevention & Acceptable Use Framework',
        sourceMarkdown: '# Internal framework',
        acceptanceMode: 'agreement',
        isPublic: true,
        createdBy: 'A1'
    }));
    test('I32-5. createDraft safely rejects canonical semantic overrides', () => {
        assert.strictEqual(createOverride.status, 400);
        assert.strictEqual(createOverride.code, 'CANONICAL_POLICY_OVERRIDE');
        assert.strictEqual(docs.length, 1);
    });

    const updateOverride = await expectReject(() => legalService.updateDraft(amlDraft._id, { isPublic: true }));
    test('I32-6. updateDraft safely rejects overrides without mutating AML', () => {
        assert.strictEqual(updateOverride.code, 'CANONICAL_POLICY_OVERRIDE');
        assert.strictEqual(amlDraft.isPublic, false);
        assert.strictEqual(amlDraft.acceptanceMode, 'none');
    });

    const hiddenByType = await expectReject(() => legalService.getCurrentByType('aml_kyc'));
    test('I32-7. public current-by-type API excludes AML', () => {
        assert.strictEqual(hiddenByType.status, 404);
        assert.strictEqual(hiddenByType.code, 'DOCUMENT_NOT_PUBLISHED');
    });

    const amlV1 = await legalService.publish(amlDraft._id, { publishedBy: 'A1' });
    test('I32-8. AML publication preserves version and content-hash behavior', () => {
        assert.strictEqual(amlV1.version, 1);
        assert.strictEqual(amlV1.contentHash, computeHash(amlV1.contentHtml));
        assert.strictEqual(amlV1.isPublic, false);
    });

    const amlV2Draft = await legalService.createDraft({
        documentType: 'aml_kyc',
        sourceMarkdown: '# Internal framework v2',
        createdBy: 'A1'
    });
    const amlV2 = await legalService.publish(amlV2Draft._id, { publishedBy: 'A1' });
    test('I32-9. AML supersession archives v1 and publishes exactly one v2', () => {
        assert.strictEqual(amlV1.status, 'archived');
        assert.strictEqual(amlV2.version, 2);
        assert.strictEqual(docs.filter(d => d.documentType === 'aml_kyc' && d.status === 'published').length, 1);
    });

    const terms = await legalService.publish((await legalService.createDraft({ ...TOS_AGREE, createdBy: 'A1' }))._id, { publishedBy: 'A1' });
    const privacy = await legalService.publish((await legalService.createDraft({ ...PRIVACY_ACK, createdBy: 'A1' }))._id, { publishedBy: 'A1' });
    const refund = await legalService.publish((await legalService.createDraft({ ...REFUND_NONE, createdBy: 'A1' }))._id, { publishedBy: 'A1' });
    const publicDocs = await legalService.getCurrentDocuments();
    test('I32-10. public list includes the three public types and excludes published AML', () => {
        assert.deepStrictEqual(publicDocs.map(d => d.documentType).sort(), ['privacy', 'refund_complaints', 'terms']);
        assert.strictEqual(publicDocs.find(d => d.documentType === 'refund_complaints').requiresAcceptance, false);
    });

    const requirements = await legalService.getRequirements({});
    test('I32-11. requirements exclude AML and keep refund public but informational', () => {
        assert.ok(!requirements.documents.some(d => d.documentType === 'aml_kyc'));
        assert.deepStrictEqual(requirements.missingAcceptances.sort(), ['privacy', 'terms']);
        assert.strictEqual(requirements.documents.find(d => d.documentType === 'refund_complaints').acceptanceRequired, false);
    });

    const signupRows = await legalService.validateSignupAcceptances([
        { documentType: 'terms', version: terms.version, contentHash: terms.contentHash, channel: 'web' },
        { documentType: 'privacy', version: privacy.version, contentHash: privacy.contentHash, channel: 'web' },
        { documentType: 'refund_complaints', version: refund.version, contentHash: refund.contentHash, channel: 'web' },
        { documentType: 'aml_kyc', version: amlV2.version, contentHash: amlV2.contentHash, channel: 'web' }
    ]);
    test('I32-12. signup creates only canonical terms/privacy acceptance rows', () => {
        assert.deepStrictEqual(signupRows.map(r => `${r.documentType}:${r.acceptanceType}`).sort(),
            ['privacy:acknowledgement', 'terms:agreement']);
    });

    const amlAcceptance = await expectReject(() => legalService.recordAcceptance({
        userId: 'U_I32', documentType: 'aml_kyc', version: amlV2.version, contentHash: amlV2.contentHash
    }));
    const refundAcceptance = await expectReject(() => legalService.recordAcceptance({
        userId: 'U_I32', documentType: 'refund_complaints', version: refund.version, contentHash: refund.contentHash
    }));
    test('I32-13. customer acceptance rejects AML and informational refund without writing rows', () => {
        assert.strictEqual(amlAcceptance.code, 'ACCEPTANCE_NOT_REQUIRED');
        assert.strictEqual(refundAcceptance.code, 'ACCEPTANCE_NOT_REQUIRED');
        assert.strictEqual(accepts.length, 0);
    });

    await legalService.recordAcceptance({
        userId: 'U_I32', documentType: 'terms', version: terms.version, contentHash: terms.contentHash
    });
    await legalService.recordAcceptance({
        userId: 'U_I32', documentType: 'privacy', version: privacy.version, contentHash: privacy.contentHash
    });
    let guardPassed = false;
    const guardRes = makeRes();
    await requireLegalCompliance({ user: { id: 'U_I32' } }, guardRes, () => { guardPassed = true; });
    test('I32-14. transaction guard passes on terms/privacy alone despite published refund and AML', () => {
        assert.strictEqual(guardPassed, true);
        assert.strictEqual(guardRes.statusCode, null);
    });

    const missingSeedContent = getMissingApprovedContent(null);
    test('I32-15. controlled seed fails closed and identifies every missing approved type', () => {
        assert.ok(missingSeedContent.includes('APPROVED: true'));
        for (const type of LegalDocument.DOCUMENT_TYPES) {
            assert.ok(missingSeedContent.includes(`${type} content`), `missing ${type} must be listed`);
        }
    });

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
