const mongoose = require('mongoose');
const User = require('../models/User');
const LegalDocument = require('../models/LegalDocument');
const legalService = require('../services/legalDocument.service');

// Authoritative content gate: kept empty in this commit. The final approved
// All four legal document types must be reviewed, approved and placed in
// scripts/legal_content/approved.js (with APPROVED: true) before this seed is
// run. Placeholder wording must NEVER be seed/published.
let APPROVED_CONTENT = null;
try {
    APPROVED_CONTENT = require('./legal_content/approved.js');
} catch (_) {
    APPROVED_CONTENT = null;
}

function getMissingApprovedContent(content) {
    const missing = [];
    if (!content || content.APPROVED !== true) missing.push('APPROVED: true');
    for (const type of LegalDocument.DOCUMENT_TYPES) {
        if (!content || !content[type]) {
            missing.push(`${type} content`);
            continue;
        }
        if (!content[type].version) missing.push(`${type}.version`);
        if (!content[type].markdown) missing.push(`${type}.markdown`);
    }
    return missing;
}

function isSuperAdmin(user) {
    if (!user) return false;
    if (user.status === false) return false; // inactive accounts can never publish
    const roles = Array.isArray(user.roles) ? user.roles : [];
    if (user.role === 'superAdmin' || roles.includes('superAdmin')) return true;
    return false;
}

async function resolveActor() {
    // Prefer a real superAdmin & active user.
    const real = await User.findOne({ $or: [{ role: 'superAdmin' }, { roles: 'superAdmin' }] }).sort({ createdAt: 1 }).select('_id role roles name status');
    if (real && isSuperAdmin(real)) return real;

    // Fallback: BOOTSTRAP_ACTOR_ID must point to an existing superAdmin.
    const actorId = process.env.BOOTSTRAP_ACTOR_ID;
    if (actorId && mongoose.isValidObjectId(actorId)) {
        const byId = await User.findById(actorId).select('_id role roles name status _id');
        if (byId && isSuperAdmin(byId)) return byId;
    }

    return null;
}

async function seedLegalDocuments() {
    require('dotenv').config();
    console.log('====================================================');
    console.log('       ZANTARA LEGAL DOCUMENTS SEED / BASELINE');
    console.log('====================================================\n');

    try {
        // 1. Pending-content gate -> fail safely, zero writes.
        const missingApprovedContent = getMissingApprovedContent(APPROVED_CONTENT);
        if (missingApprovedContent.length > 0) {
            console.error('ABORT: No approved legal content is bundled.');
            console.error(`Missing approved types/content: ${missingApprovedContent.join(', ')}`);
            console.error('All four canonical documents must be separately approved and');
            console.error('placed in scripts/legal_content/approved.js');
            console.error('(with APPROVED: true) before legal documents are published.');
            console.error('No documents were written.');
            process.exit(3);
        }

        const mongoUri = process.env.MONGO_URI;
        if (!mongoUri) {
            console.error('ERROR: MONGO_URI is not set in environment.');
            process.exit(1);
        }

        await mongoose.connect(mongoUri);
        console.log('Connected to MongoDB successfully.\n');

        // 2. Strict actor rule.
        const actor = await resolveActor();
        if (!actor) {
            console.error('ABORT: No legitimate actor found. A real, active superAdmin');
            console.error('account is required, or BOOTSTRAP_ACTOR_ID pointing to one.');
            console.error('No documents were written.');
            process.exit(3);
        }
        console.log(`[+] Actor: ${actor._id} (superAdmin, active)\n`);

        const drafts = LegalDocument.DOCUMENT_TYPES.map(type => ({
            type,
            config: APPROVED_CONTENT[type],
            policy: LegalDocument.DOCUMENT_POLICIES[type]
        }));

        for (const item of drafts) {
            const existing = await LegalDocument.findOne({ documentType: item.type, status: 'published' });
            if (existing) {
                console.log(`[*] ${item.type}: already has a published version (v${existing.version}) - skipping.`);
                continue;
            }
            const doc = await legalService.createDraft({
                documentType: item.type,
                title: item.policy.displayName,
                sourceMarkdown: item.config.markdown,
                changeSummary: item.config.changeSummary || 'Initial approved version',
                acceptanceMode: item.policy.acceptanceMode,
                isPublic: item.policy.isPublic,
                requiresReacceptance: false,
                createdBy: actor._id
            });
            const published = await legalService.publish(doc._id, { publishedBy: actor._id });
            console.log(`[+] ${item.type}: published v${published.version} (${item.policy.acceptanceMode})`);
        }

        console.log('\nLegal document seed completed successfully.');
        process.exit(0);
    } catch (err) {
        console.error('Seed error:', err.message);
        process.exit(1);
    }
}

if (require.main === module) {
    seedLegalDocuments();
}

module.exports = seedLegalDocuments;
module.exports.getMissingApprovedContent = getMissingApprovedContent;
