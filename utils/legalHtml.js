const crypto = require('crypto');
const { marked } = require('marked');
const sanitizeHtmlLib = require('sanitize-html');

// Allowlist for canonical legal-document HTML. No scripts, no inline handlers,
// no style tags. Targets headings, prose, lists, links, tables and inline code.
const ALLOWED_TAGS = [
    'h1', 'h2', 'h3', 'h4', 'p', 'br',
    'ul', 'ol', 'li',
    'a', 'strong', 'em', 'b', 'i', 'blockquote', 'hr',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'code', 'pre'
];

const ALLOWED_ATTRIBUTES = {
    a: ['href', 'rel', 'target'],
    th: ['align'],
    td: ['align'],
    code: ['class']
};

const markdownToHtml = (markdown) => {
    if (!markdown || typeof markdown !== 'string') return '';
    const rawHtml = marked.parse(markdown);
    return sanitizeHtml(rawHtml);
};

const sanitizeHtml = (html) => {
    if (!html) return '';
    return sanitizeHtmlLib(html, {
        allowedTags: ALLOWED_TAGS,
        allowedAttributes: ALLOWED_ATTRIBUTES,
        allowedSchemes: ['https', 'http', 'mailto'],
        allowProtocolRelative: false,
        transformTags: {
            a: sanitizeHtmlLib.simpleTransform('a', { rel: 'noopener noreferrer nofollow', target: '_blank' })
        }
    });
};

// Canonical artifact for hashing is the sanitized contentHtml (trimmed).
const computeHash = (contentHtml) => {
    if (typeof contentHtml !== 'string') contentHtml = '';
    return crypto.createHash('sha256').update(contentHtml.trim()).digest('hex');
};

const verifyHash = (doc, contentHtml) => {
    if (!doc || !doc.contentHash) return false;
    return doc.contentHash === computeHash(contentHtml || doc.contentHtml);
};

module.exports = { markdownToHtml, sanitizeHtml, computeHash, verifyHash };