require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const LegalDocument = require('../models/LegalDocument');
const legalService = require('../services/legalDocument.service');

// Authoritative content gate: kept empty in this commit. The final approved
// Zantara Terms of Service v1.0, Privacy Policy v1.0 and Refund, Reversal &
// Complaints Policy v1.0 must be reviewed, approved and placed in
// scripts/legal_content/approved.js (with APPROVED: true) before this seed is
// run. Placeholder wording must NEVER be seed/published.
let APPROVED_CONTENT = null;
try {
    APPROVED_CONTENT = require('./legal_content/approved.js');
} catch (_) {
    APPROVED_CONTENT = null;
}

const isApproved = (content) =>
    content && content.APPROVED === true &&
    content.terms && content.terms.version && content.terms.title && content.terms.markdown &&
    content.privacy && content.privacy.version && content.privacy.title && content.privacy.markdown &&
    content.refund_complaints && content.refund_complaints.version && content.refund_complaints.title && content.refund_complaints.markdown;

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
    console.log('====================================================');
    console.log('       ZANTARA LEGAL DOCUMENTS SEED / BASELINE');
    console.log('====================================================\n');

    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
        console.error('ERROR: MONGO_URI is not set in environment.');
        process.exit(1);
    }

    try {
        // 1. Pending-content gate -> fail safely, zero writes.
        if (!isApproved(APPROVED_CONTENT)) {
            console.error('ABORT: No approved legal content is bundled.');
            console.error('The Zantara Terms of Service v1.0, Privacy Policy v1.0 and');
            console.error('Refund, Reversal & Complaints Policy v1.0 must be separately');
            console.error('approved and placed in scripts/legal_content/approved.js');
            console.error('(with APPROVED: true) before legal documents are published.');
            console.error('No documents were written.');
            process.exit(3);
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

        const drafts = [
            { type: 'terms', config: APPROVED_CONTENT.terms, acceptanceMode: 'agreement', requiresReacceptance: false },
            { type: 'privacy', config: APPROVED_CONTENT.privacy, acceptanceMode: 'acknowledgement', requiresReacceptance: false },
            { type: 'refund_complaints', config: APPROVED_CONTENT.refund_complaints, acceptanceMode: 'none', requiresReacceptance: false }
        ];

        for (const item of drafts) {
            const existing = await LegalDocument.findOne({ documentType: item.type, status: 'published' });
            if (existing) {
                console.log(`[*] ${item.type}: already has a published version (v${existing.version}) - skipping.`);
                continue;
            }
            const doc = await legalService.createDraft({
                documentType: item.type,
                title: item.config.title,
                sourceMarkdown: item.config.markdown,
                changeSummary: item.config.changeSummary || 'Initial approved version',
                acceptanceMode: item.acceptanceMode,
                requiresReacceptance: item.requiresReacceptance,
                createdBy: actor._id
            });
            const published = await legalService.publish(doc._id, { publishedBy: actor._id });
            console.log(`[+] ${item.type}: published v${published.version} (${item.acceptanceMode})`);
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