const crypto = require('crypto');

/**
 * Validates and retrieves the 32-byte Buffer key for AES-256-GCM.
 * In production and staging, PROVIDER_CREDENTIAL_ENCRYPTION_KEY is strictly required
 * and must be a valid 32-byte key (64 hex characters or 44 base64 characters).
 * Silent derivation or fallback is prohibited in production and staging.
 */
function getSecretKeyBuffer() {
    const keyEnv = process.env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY;
    const isProdOrStaging = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging';

    if (!keyEnv) {
        if (isProdOrStaging) {
            throw new Error('[Crypto] PROVIDER_CREDENTIAL_ENCRYPTION_KEY is required in production and staging environments.');
        }
        // Explicitly documented development fallback: derive 32-byte key from JWT_SECRET or default dev string
        const fallbackSecret = process.env.JWT_SECRET || 'zantara-default-dev-encryption-key-32b';
        return crypto.createHash('sha256').update(fallbackSecret).digest();
    }

    // Hex format (64 chars = 32 bytes)
    if (keyEnv.length === 64 && /^[0-9a-fA-F]+$/.test(keyEnv)) {
        return Buffer.from(keyEnv, 'hex');
    }

    // Base64 format (44 chars = 32 bytes)
    if (keyEnv.length === 44 && /^[A-Za-z0-9+/=]+$/.test(keyEnv)) {
        const buf = Buffer.from(keyEnv, 'base64');
        if (buf.length === 32) return buf;
    }

    if (isProdOrStaging) {
        throw new Error('[Crypto] Invalid PROVIDER_CREDENTIAL_ENCRYPTION_KEY in production/staging. Key must be a valid 32-byte key in hex (64 chars) or base64 (44 chars) format.');
    }

    // Explicitly documented development fallback: SHA-256 hash of arbitrary keyEnv string
    return crypto.createHash('sha256').update(keyEnv).digest();
}

/**
 * Checks if a string is encrypted using the zantara format.
 */
function isEncrypted(value) {
    return typeof value === 'string' && value.startsWith('enc:v1:');
}

/**
 * Encrypts a sensitive string using AES-256-GCM.
 */
function encryptSecret(text) {
    if (!text || typeof text !== 'string') return text;
    if (isEncrypted(text)) return text; // Prevent double encryption

    const key = getSecretKeyBuffer();
    const iv = crypto.randomBytes(12); // Standard 12-byte IV for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');

    return `enc:v1:${iv.toString('hex')}:${tag}:${encrypted}`;
}

/**
 * Decrypts an AES-256-GCM encrypted string.
 * Returns legacy plaintext unchanged for backward compatibility.
 */
function decryptSecret(value) {
    if (!value || typeof value !== 'string') return value;
    if (!isEncrypted(value)) return value; // Legacy plaintext fallback

    try {
        const parts = value.split(':');
        if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
            return value;
        }

        const iv = Buffer.from(parts[2], 'hex');
        const tag = Buffer.from(parts[3], 'hex');
        const encryptedText = parts[4];

        const key = getSecretKeyBuffer();
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);

        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    } catch (err) {
        console.error('[Crypto] Decryption failed:', err.message);
        return value;
    }
}

module.exports = {
    encryptSecret,
    decryptSecret,
    isEncrypted
};
