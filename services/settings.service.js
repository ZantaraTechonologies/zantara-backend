const Setting = require('../models/Setting');

class SettingsService {
    constructor() {
        this.cache = new Map();
        this.lastRefresh = 0;
        this.CACHE_TTL = 1000 * 60 * 5; // 5 minutes
    }

    /**
     * Retrieves a setting value by key.
     * Falls back to environment variable if not in DB.
     */
    async getSetting(key, defaultValue = null) {
        // Refresh cache if expired
        if (Date.now() - this.lastRefresh > this.CACHE_TTL) {
            await this.refreshCache();
        }

        if (this.cache.has(key)) {
            return this.cache.get(key);
        }

        // Fallback to .env if not found in DB
        const envValue = process.env[key];
        return envValue !== undefined ? envValue : defaultValue;
    }

    async refreshCache() {
        try {
            const settings = await Setting.find();
            this.cache.clear();
            settings.forEach(s => {
                this.cache.set(s.key, s.value);
            });
            this.lastRefresh = Date.now();
        } catch (err) {
            console.error('Failed to refresh settings cache:', err);
        }
    }

    /**
     * Updates or creates a setting.
     */
    async updateSetting(key, value) {
        await Setting.findOneAndUpdate(
            { key },
            { key, value },
            { upsert: true, new: true }
        );
        this.cache.set(key, value); // Optimistic update
    }

    /**
     * Bulk update settings
     */
    async bulkUpdate(settingsMap) {
        const ops = Object.entries(settingsMap).map(([key, value]) => ({
            updateOne: {
                filter: { key },
                update: { key, value },
                upsert: true
            }
        }));

        if (ops.length > 0) {
            await Setting.bulkWrite(ops);
            await this.refreshCache();
        }
    }
}

module.exports = new SettingsService();
