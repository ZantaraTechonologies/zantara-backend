'use strict';

/**
 * C1 batch 3: settlement integrity requirements R1-R12.
 *
 * This is intentionally a RED contract suite. It exercises the real
 * paymentGateway service against a transactional in-memory store while the
 * production settlement API and persisted claim/evidence fields are completed.
 */

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const TransactionStatus = require('../models/TransactionStatus');
const WalletLedger = require('../models/WalletLedger');
const Transaction = require('../models/Transaction');
const paymentGatewayService = require('../services/paymentGateway.service');
const walletService = require('../services/wallet.service');
const investmentService = require('../services/investment.service');
const notificationService = require('../services/notification.service');

const originals = {
    startSession: mongoose.startSession,
    statusFindOne: TransactionStatus.findOne,
    statusFind: TransactionStatus.find,
    statusUpdateOne: TransactionStatus.updateOne,
    ledgerFindOne: WalletLedger.findOne,
    walletCredit: walletService.credit,
    fulfillSharePurchase: investmentService.fulfillSharePurchase,
    getInvestmentSettings: investmentService.getInvestmentSettings,
    transactionFindOne: Transaction.findOne,
    transactionCreate: Transaction.create,
    sendFundingSuccess: notificationService.sendFundingSuccess
};

let records;
let wallets;
let ledger;
let fulfillments;
let audits;
let notifications;
let events;
let sessionSequence;
let commitBarrier;
let failFinalize;

function clone(value) {
    if (value == null) return value;
    return structuredClone(value);
}

function comparable(value) {
    return value instanceof Date ? value.getTime() : value;
}

function matchesValue(actual, expected) {
    if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof Date)) {
        if (Object.prototype.hasOwnProperty.call(expected, '$lt')) {
            return actual != null && comparable(actual) < comparable(expected.$lt);
        }
        if (Object.prototype.hasOwnProperty.call(expected, '$lte')) {
            return actual != null && comparable(actual) <= comparable(expected.$lte);
        }
        if (Object.prototype.hasOwnProperty.call(expected, '$in')) {
            return expected.$in.includes(actual);
        }
        if (Object.prototype.hasOwnProperty.call(expected, '$exists')) {
            return expected.$exists ? actual !== undefined : actual === undefined;
        }
    }
    return comparable(actual) === comparable(expected);
}

function matches(item, filter = {}) {
    if (filter.$or && !filter.$or.some(part => matches(item, part))) return false;
    return Object.entries(filter).every(([key, expected]) => {
        if (key === '$or') return true;
        return matchesValue(item[key], expected);
    });
}

function applyUpdate(item, update = {}) {
    if (update.$set) Object.assign(item, clone(update.$set));
    if (update.$unset) {
        for (const key of Object.keys(update.$unset)) delete item[key];
    }
    if (update.$inc) {
        for (const [key, amount] of Object.entries(update.$inc)) {
            item[key] = Number(item[key] || 0) + amount;
        }
    }
}

function query(value, sessionReader) {
    return {
        session: session => Promise.resolve(sessionReader ? sessionReader(session) : value),
        then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
        catch: reject => Promise.resolve(value).catch(reject)
    };
}

function makeBarrier(parties) {
    let arrivals = 0;
    let release;
    const ready = new Promise(resolve => { release = resolve; });
    return {
        async wait() {
            arrivals++;
            if (arrivals === parties) release();
            await ready;
        }
    };
}

function createSession() {
    const session = {
        id: `session-${++sessionSequence}`,
        active: false,
        aborted: false,
        recordVersions: new Map(),
        stagedRecords: new Map(),
        walletVersions: new Map(),
        stagedWallets: new Map(),
        stagedLedger: [],
        stagedFulfillments: [],
        stagedAudits: [],
        startTransaction() {
            this.active = true;
        },
        readRecord(refId) {
            if (this.stagedRecords.has(refId)) return clone(this.stagedRecords.get(refId));
            const current = records.get(refId);
            if (!current) return null;
            if (!this.recordVersions.has(refId)) this.recordVersions.set(refId, current._version);
            return clone(current);
        },
        stageRecord(record) {
            if (!this.recordVersions.has(record.refId)) {
                const current = records.get(record.refId);
                this.recordVersions.set(record.refId, current ? current._version : -1);
            }
            this.stagedRecords.set(record.refId, clone(record));
        },
        stageCredit(userId, amount, reference, source) {
            const current = wallets.get(userId);
            if (!current) throw new Error('Wallet not found');
            if (!this.walletVersions.has(userId)) this.walletVersions.set(userId, current._version);
            const staged = this.stagedWallets.get(userId) || clone(current);
            const balanceBefore = staged.balance;
            staged.balance += amount;
            this.stagedWallets.set(userId, staged);
            this.stagedLedger.push({
                walletId: `wallet-${userId}`,
                userId,
                reference,
                entryType: 'credit',
                source,
                amount,
                balanceBefore,
                balanceAfter: staged.balance
            });
            return staged.balance;
        },
        async commitTransaction() {
            if (commitBarrier) await commitBarrier.wait();

            for (const [refId, version] of this.recordVersions) {
                const current = records.get(refId);
                if (!current || current._version !== version) {
                    const error = new Error('WriteConflict: settlement record changed before commit');
                    error.code = 112;
                    throw error;
                }
            }
            for (const [userId, version] of this.walletVersions) {
                const current = wallets.get(userId);
                if (!current || current._version !== version) {
                    const error = new Error('WriteConflict: wallet changed before commit');
                    error.code = 112;
                    throw error;
                }
            }

            for (const [refId, staged] of this.stagedRecords) {
                records.set(refId, { ...clone(staged), _version: records.get(refId)._version + 1 });
            }
            for (const [userId, staged] of this.stagedWallets) {
                wallets.set(userId, { ...clone(staged), _version: wallets.get(userId)._version + 1 });
            }
            ledger.push(...clone(this.stagedLedger));
            fulfillments.push(...clone(this.stagedFulfillments));
            audits.push(...clone(this.stagedAudits));
            this.active = false;
            events.push({ kind: 'commit', sessionId: this.id });
        },
        async abortTransaction() {
            this.aborted = true;
            this.active = false;
            this.stagedRecords.clear();
            this.stagedWallets.clear();
            this.stagedLedger = [];
            this.stagedFulfillments = [];
            this.stagedAudits = [];
        },
        endSession() {}
    };
    return session;
}

function installMocks() {
    mongoose.startSession = async () => createSession();

    TransactionStatus.findOne = (filter = {}) => {
        const current = [...records.values()].find(item => matches(item, filter));
        return query(current ? clone(current) : null, session => {
            const candidate = [...records.keys()]
                .map(refId => session.readRecord(refId))
                .find(item => item && matches(item, filter));
            return candidate || null;
        });
    };

    TransactionStatus.find = async (filter = {}) => {
        return [...records.values()].filter(item => matches(item, filter)).map(clone);
    };

    TransactionStatus.updateOne = async (filter = {}, update = {}, options = {}) => {
        const session = options.session;
        if (session) {
            const candidate = [...records.keys()]
                .map(refId => session.readRecord(refId))
                .find(item => item && matches(item, filter));
            if (!candidate) return { matchedCount: 0, modifiedCount: 0 };
            if (failFinalize && filter.status === 'settlement_pending' && update.$set?.status === 'success') {
                throw new Error('injected finalize failure');
            }
            applyUpdate(candidate, update);
            session.stageRecord(candidate);
            return { matchedCount: 1, modifiedCount: 1 };
        }

        const entry = [...records.entries()].find(([, item]) => matches(item, filter));
        if (!entry) return { matchedCount: 0, modifiedCount: 0 };
        const [refId, current] = entry;
        const updated = clone(current);
        applyUpdate(updated, update);
        records.set(refId, { ...updated, _version: current._version + 1 });
        return { matchedCount: 1, modifiedCount: 1 };
    };

    WalletLedger.findOne = (filter = {}) => {
        const current = ledger.find(item => matches(item, filter)) || null;
        return query(current, session => {
            return [...ledger, ...session.stagedLedger].find(item => matches(item, filter)) || null;
        });
    };

    walletService.credit = async (userId, amount, reference, source, transactionId, session) => {
        if (!session) throw new Error('settlement credit must participate in the settlement session');
        const balance = session.stageCredit(String(userId), amount, reference, source);
        return { balance };
    };

    investmentService.fulfillSharePurchase = async (
        userId,
        qty,
        refId,
        isWalletPayment,
        session,
        sharePriceOverride
    ) => {
        if (!session) throw new Error('settlement fulfillment must participate in the settlement session');
        session.stagedFulfillments.push({
            userId: String(userId),
            qty,
            refId,
            isWalletPayment,
            sharePriceOverride
        });
        return { success: true, qtyPurchased: qty };
    };

    investmentService.getInvestmentSettings = async () => ({ sharePrice: 10000 });

    Transaction.findOne = filter => query(
        audits.find(item => matches(item, filter)) || null,
        session => [...audits, ...session.stagedAudits].find(item => matches(item, filter)) || null
    );

    Transaction.create = async (docs, options = {}) => {
        const rows = Array.isArray(docs) ? docs : [docs];
        const created = rows.map((doc, index) => ({ ...clone(doc), _id: `audit-${audits.length + index + 1}` }));
        if (options.session) options.session.stagedAudits.push(...created);
        else audits.push(...created);
        for (const doc of created) events.push({ kind: 'audit', refId: doc.refId });
        return Array.isArray(docs) ? created : created[0];
    };

    notificationService.sendFundingSuccess = async payload => {
        notifications.push(clone(payload));
        events.push({ kind: 'notification', refId: payload.reference });
        return { success: true };
    };
}

function reset(overrides = {}) {
    records = new Map();
    wallets = new Map();
    ledger = [];
    fulfillments = [];
    audits = [];
    notifications = [];
    events = [];
    sessionSequence = 0;
    commitBarrier = null;
    failFinalize = false;

    if (overrides.wallets) {
        for (const [userId, balance] of Object.entries(overrides.wallets)) {
            wallets.set(userId, { userId, balance, _version: 0 });
        }
    }
}

function validRecord(refId, overrides = {}) {
    const record = {
        refId,
        userId: 'user-owner',
        type: 'funding',
        status: 'processing',
        amount: 5000,
        amountKobo: 500000,
        confirmedAmountKobo: 500000,
        confirmedCurrency: 'NGN',
        expectedCurrency: 'NGN',
        confirmedProvider: 'paystack',
        confirmedReference: refId,
        confirmedProviderRef: `PS-${refId}`,
        provider: 'paystack',
        service: 'Paystack',
        channels: ['bank_transfer'],
        lastAttempt: new Date(Date.now() - 60 * 60 * 1000),
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        updatedAt: new Date(Date.now() - 60 * 60 * 1000),
        _version: 0,
        ...overrides
    };
    records.set(refId, record);
    if (record.userId && !wallets.has(String(record.userId))) {
        wallets.set(String(record.userId), { userId: String(record.userId), balance: 1000, _version: 0 });
    }
    return record;
}

function committedRecord(refId) {
    return records.get(refId);
}

function financialEffects() {
    return ledger.length + fulfillments.length;
}

async function expectSettlementRejected(refId, message) {
    let rejected = false;
    try {
        const result = await paymentGatewayService.adminSettleProcessing({
            refId,
            adminId: 'admin-integrity',
            note: 'batch3 integrity test'
        });
        rejected = !result || result.settled !== true;
    } catch (_) {
        rejected = true;
    }
    assert.equal(rejected, true, message);
    assert.notEqual(committedRecord(refId).status, 'success', `${message}: status must not become success`);
    assert.equal(financialEffects(), 0, `${message}: no wallet/share value may be created`);
}

async function main() {
    installMocks();
    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            await fn();
            passed++;
            console.log(`[PASS] ${name}`);
        } catch (error) {
            failed++;
            console.error(`[FAIL] ${name}`);
            console.error(`       ${error.message}`);
            if (process.env.VERBOSE) console.error(error.stack);
        }
    }

    try {
        await test('R1 legacy retry has no authority to settle failed funding', async () => {
            reset();
            validRecord('R1-FAILED', { status: 'failed' });

            const result = await paymentGatewayService.recoverStrandedSettlements({ maxAgeMs: 1000 });
            assert.deepEqual(result, { scanned: 0, settled: 0, skipped: 0 });
            assert.equal(committedRecord('R1-FAILED').status, 'failed');
            assert.equal(financialEffects(), 0);

            // Supplementary wiring assertion: no cron path may bypass the service
            // evidence/claim state machine and directly credit provider metadata.
            const cronSource = fs.readFileSync(
                path.join(__dirname, '..', 'cron', 'transactionRetryCron.js'),
                'utf8'
            );
            assert.doesNotMatch(cronSource, /\bretryFunding\b/, 'legacy retryFunding remains authoritative in the cron');
        });

        await test('R2 wrong confirmed provider is rejected without value', async () => {
            reset();
            validRecord('R2-PROVIDER', { confirmedProvider: 'flutterwave' });
            await expectSettlementRejected('R2-PROVIDER', 'provider binding mismatch must reject settlement');
        });

        await test('R3 wrong confirmed reference is rejected without value', async () => {
            reset();
            validRecord('R3-REFERENCE', { confirmedReference: 'ATTACKER-REFERENCE' });
            await expectSettlementRejected('R3-REFERENCE', 'confirmed reference mismatch must reject settlement');
        });

        await test('R4 confirmed amount must equal the initialized amount', async () => {
            reset();
            validRecord('R4-AMOUNT', { amountKobo: 500000, confirmedAmountKobo: 900000 });
            await expectSettlementRejected('R4-AMOUNT', 'amount mismatch must reject settlement');
        });

        await test('R5 non-NGN confirmed currency is rejected without value', async () => {
            reset();
            validRecord('R5-CURRENCY', { confirmedCurrency: 'USD' });
            await expectSettlementRejected('R5-CURRENCY', 'currency mismatch must reject settlement');
        });

        await test('R6 complete persisted confirmation evidence is mandatory', async () => {
            const requiredEvidence = [
                'confirmedAmountKobo',
                'confirmedCurrency',
                'confirmedProvider',
                'confirmedReference',
                'confirmedProviderRef'
            ];
            const violations = [];

            for (const field of requiredEvidence) {
                reset();
                const record = validRecord(`R6-${field}`);
                delete record[field];
                try {
                    await expectSettlementRejected(record.refId, `missing ${field} must reject settlement`);
                } catch (error) {
                    violations.push(error.message);
                }
            }

            assert.deepEqual(violations, [], violations.join(' | '));
        });

        await test('R7 settlement requires an authoritative persisted user', async () => {
            reset();
            validRecord('R7-NO-USER', {
                userId: null,
                metadata: { userId: 'metadata-attacker' }
            });
            await expectSettlementRejected('R7-NO-USER', 'missing authoritative user must fail closed');
        });

        await test('R8 metadata cannot redirect settlement away from TransactionStatus.userId', async () => {
            reset();
            validRecord('R8-RECIPIENT', {
                userId: 'real-owner',
                metadata: { userId: 'metadata-attacker', recipient: 'metadata-attacker' }
            });
            wallets.set('real-owner', { userId: 'real-owner', balance: 250, _version: 0 });
            wallets.set('metadata-attacker', { userId: 'metadata-attacker', balance: 900, _version: 0 });

            const result = await paymentGatewayService.adminSettleProcessing({ refId: 'R8-RECIPIENT' });

            assert.equal(result.settled, true);
            assert.equal(ledger.length, 1);
            assert.equal(ledger[0].userId, 'real-owner');
            assert.equal(wallets.get('real-owner').balance, 5250);
            assert.equal(wallets.get('metadata-attacker').balance, 900);
        });

        await test('R9 concurrent settlement creates value exactly once without ledger uniqueness', async () => {
            reset();
            validRecord('R9-CONCURRENT');
            const outcomes = await Promise.allSettled([
                paymentGatewayService.adminSettleProcessing({ refId: 'R9-CONCURRENT', adminId: 'admin-a' }),
                paymentGatewayService.adminSettleProcessing({ refId: 'R9-CONCURRENT', adminId: 'admin-b' })
            ]);

            assert.equal(outcomes.filter(item => item.status === 'fulfilled' && item.value.settled).length, 1);
            assert.equal(ledger.length, 1, 'exactly one ordinary ledger row must be committed');
            assert.equal(wallets.get('user-owner').balance, 6000);
            assert.equal(committedRecord('R9-CONCURRENT').status, 'success');
            assert.equal(
                WalletLedger.schema.indexes().some(([keys, options]) => keys.reference === 1 && options.unique),
                false,
                'the test must not depend on invented WalletLedger.reference uniqueness'
            );
        });

        await test('R10 stale settlement claim token cannot fulfill or finalize', async () => {
            reset();
            validRecord('R10-STALE-TOKEN', {
                type: 'investment_buy',
                status: 'settlement_pending',
                amount: 20000,
                amountKobo: 2000000,
                confirmedAmountKobo: 2000000,
                sharePrice: 10000,
                settlementClaimToken: 'fresh-owner-token',
                settlementLeaseExpiresAt: new Date(Date.now() + 60 * 1000)
            });

            let rejected = false;
            try {
                const result = await paymentGatewayService.adminSettleProcessing({
                    refId: 'R10-STALE-TOKEN',
                    claimToken: 'stale-worker-token'
                });
                rejected = !result || result.settled !== true;
            } catch (_) {
                rejected = true;
            }

            assert.equal(rejected, true, 'a worker that no longer owns the claim must be rejected');
            assert.equal(fulfillments.length, 0, 'stale claim must not fulfill shares');
            assert.equal(committedRecord('R10-STALE-TOKEN').status, 'settlement_pending');
            assert.equal(committedRecord('R10-STALE-TOKEN').settlementClaimToken, 'fresh-owner-token');
        });

        await test('R11 recovery ignores an old record with a fresh settlement claim lease', async () => {
            reset();
            validRecord('R11-FRESH-CLAIM', {
                status: 'settlement_pending',
                createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
                lastAttempt: new Date(Date.now() - 24 * 60 * 60 * 1000),
                settlementClaimToken: 'active-worker-token',
                settlementLeaseExpiresAt: new Date(Date.now() + 60 * 1000)
            });

            const result = await paymentGatewayService.recoverStrandedSettlements({ maxAgeMs: 15 * 60 * 1000 });

            assert.deepEqual(result, { scanned: 0, settled: 0, skipped: 0 });
            assert.equal(committedRecord('R11-FRESH-CLAIM').status, 'settlement_pending');
            assert.equal(financialEffects(), 0);
        });

        await test('R12 transaction rollback leaves neither success nor wallet/share value', async () => {
            reset();
            validRecord('R12-ROLLBACK');
            failFinalize = true;

            await assert.rejects(
                paymentGatewayService.adminSettleProcessing({ refId: 'R12-ROLLBACK' }),
                /injected finalize failure/
            );

            assert.equal(committedRecord('R12-ROLLBACK').status, 'settlement_pending');
            assert.equal(wallets.get('user-owner').balance, 1000);
            assert.equal(ledger.length, 0);
            assert.equal(fulfillments.length, 0);
            assert.equal(audits.length, 0);
            assert.equal(notifications.length, 0);
        });

        await test('R12a only funding and investment_buy settlement types are supported', async () => {
            const violations = [];
            for (const type of ['purchase', 'payout']) {
                reset();
                validRecord(`R12-TYPE-${type}`, { type });
                try {
                    await expectSettlementRejected(
                        `R12-TYPE-${type}`,
                        `unsupported type '${type}' must reject settlement`
                    );
                } catch (error) {
                    violations.push(error.message);
                }
            }
            assert.deepEqual(violations, [], violations.join(' | '));
        });

        await test('R12b committed settlement emits audit and notification exactly once, after commit', async () => {
            reset();
            validRecord('R12-POST-COMMIT');

            const first = await paymentGatewayService.adminSettleProcessing({
                refId: 'R12-POST-COMMIT',
                adminId: 'admin-audit'
            });
            assert.equal(first.settled, true);

            await assert.rejects(
                paymentGatewayService.adminSettleProcessing({
                    refId: 'R12-POST-COMMIT',
                    adminId: 'admin-audit'
                }),
                /Cannot settle/
            );

            assert.equal(audits.length, 1, 'one immutable transaction audit is required');
            assert.equal(audits[0].refId, 'R12-POST-COMMIT');
            assert.equal(audits[0].status, 'success');
            assert.equal(notifications.length, 1, 'customer notification must be exactly once');

            const commitIndex = events.findIndex(event => event.kind === 'commit');
            const auditIndex = events.findIndex(event => event.kind === 'audit');
            const notificationIndex = events.findIndex(event => event.kind === 'notification');
            assert.ok(commitIndex >= 0, 'settlement transaction must commit');
            assert.ok(auditIndex >= 0, 'financial audit must be created in the committed settlement transaction');
            assert.ok(notificationIndex > commitIndex, 'notification must be emitted only after commit');
        });

        await test('R13 one provider transaction cannot settle two local references', async () => {
            reset();
            validRecord('R13-ORIGINAL', {
                status: 'success',
                confirmedProviderRef: 'PS-SHARED-TRANSACTION'
            });
            validRecord('R13-REPLAY', {
                confirmedProviderRef: 'PS-SHARED-TRANSACTION'
            });

            await assert.rejects(
                paymentGatewayService.adminSettleProcessing({ refId: 'R13-REPLAY' }),
                error => error.code === 'PAYMENT_PROVIDER_TRANSACTION_REUSED'
            );

            assert.equal(committedRecord('R13-REPLAY').status, 'reconciliation_required');
            assert.equal(financialEffects(), 0);
        });

        await test('R14 retrying the same provider transaction for its local reference is idempotent', async () => {
            reset();
            const record = validRecord('R14-IDEMPOTENT', {
                status: 'success',
                confirmedProviderRef: 'PS-IDEMPOTENT'
            });

            const result = await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: record,
                gatewayPaymentResult: {
                    status: 'success',
                    gateway: 'paystack',
                    reference: record.refId,
                    providerTransactionId: 'PS-IDEMPOTENT',
                    amount: 5000,
                    currency: 'NGN'
                }
            });

            assert.equal(result.success, true);
            assert.equal(result.alreadyProcessed, true);
            assert.equal(financialEffects(), 0);
        });

        await test('R15 identical textual transaction IDs remain scoped by provider', async () => {
            reset();
            validRecord('R15-PAYSTACK', {
                status: 'success',
                confirmedProviderRef: 'SHARED-TEXT-ID'
            });
            validRecord('R15-FLUTTERWAVE', {
                provider: 'flutterwave',
                confirmedProvider: 'flutterwave',
                confirmedProviderRef: 'SHARED-TEXT-ID'
            });

            const result = await paymentGatewayService.adminSettleProcessing({ refId: 'R15-FLUTTERWAVE' });

            assert.equal(result.settled, true);
            assert.equal(committedRecord('R15-FLUTTERWAVE').status, 'success');
            assert.equal(financialEffects(), 1);
        });

        await test('R16 provider transaction identity has a provider-scoped partial unique index', async () => {
            const index = TransactionStatus.schema.indexes().find(([keys]) =>
                keys.confirmedProvider === 1 && keys.confirmedProviderRef === 1
            );
            assert.ok(index, 'provider transaction identity index is required');
            assert.equal(index[1].unique, true);
            assert.deepEqual(index[1].partialFilterExpression, {
                confirmedProvider: { $type: 'string' },
                confirmedProviderRef: { $type: 'string' }
            });
        });

        await test('R17 a unique-index race is converted to provider-reuse reconciliation', async () => {
            reset();
            const attempted = validRecord('R17-LOSER', { status: 'pending' });
            delete attempted.confirmedProvider;
            delete attempted.confirmedProviderRef;
            delete attempted.confirmedReference;
            delete attempted.confirmedCurrency;
            delete attempted.confirmedAmountKobo;

            const defaultFindOne = TransactionStatus.findOne;
            const defaultUpdateOne = TransactionStatus.updateOne;
            let identityReads = 0;
            TransactionStatus.findOne = (filter = {}) => {
                if (filter.confirmedProvider === 'paystack' && filter.confirmedProviderRef === 'PS-RACE-WINNER') {
                    identityReads++;
                    if (identityReads === 1) return query(null, () => null);
                }
                return defaultFindOne(filter);
            };
            TransactionStatus.updateOne = async (filter = {}, update = {}, options = {}) => {
                if (!options.session && update.$set?.confirmedProviderRef === 'PS-RACE-WINNER') {
                    validRecord('R17-WINNER', {
                        status: 'success',
                        confirmedProviderRef: 'PS-RACE-WINNER'
                    });
                    const duplicate = new Error('E11000 duplicate key error');
                    duplicate.code = 11000;
                    throw duplicate;
                }
                return defaultUpdateOne(filter, update, options);
            };

            try {
                await assert.rejects(
                    paymentGatewayService.finalizeFundingCredit({
                        transactionStatus: attempted,
                        gatewayPaymentResult: {
                            status: 'success',
                            gateway: 'paystack',
                            reference: 'R17-LOSER',
                            providerTransactionId: 'PS-RACE-WINNER',
                            amount: 5000,
                            currency: 'NGN'
                        }
                    }),
                    error => error.code === 'PAYMENT_PROVIDER_TRANSACTION_REUSED'
                );
            } finally {
                TransactionStatus.findOne = defaultFindOne;
                TransactionStatus.updateOne = defaultUpdateOne;
            }

            assert.equal(committedRecord('R17-LOSER').status, 'reconciliation_required');
            assert.equal(committedRecord('R17-LOSER').confirmedProviderRef, undefined);
            assert.equal(financialEffects(), 0);
        });

        await test('R18 rejected mismatched evidence cannot reserve a provider transaction identity', async () => {
            reset();
            const mismatched = validRecord('R18-WRONG-LOCAL', { status: 'pending' });
            const legitimate = validRecord('R18-LEGITIMATE', { status: 'pending' });
            for (const record of [mismatched, legitimate]) {
                delete record.confirmedProvider;
                delete record.confirmedProviderRef;
                delete record.confirmedReference;
                delete record.confirmedCurrency;
                delete record.confirmedAmountKobo;
            }

            await assert.rejects(
                paymentGatewayService.finalizeFundingCredit({
                    transactionStatus: mismatched,
                    gatewayPaymentResult: {
                        status: 'success',
                        gateway: 'paystack',
                        reference: 'R18-LEGITIMATE',
                        providerTransactionId: 'PS-R18-ONE-CHARGE',
                        amount: 5000,
                        currency: 'NGN'
                    }
                }),
                error => error.code === 'PAYMENT_REFERENCE_MISMATCH'
            );
            assert.equal(committedRecord('R18-WRONG-LOCAL').confirmedProvider, undefined);
            assert.equal(committedRecord('R18-WRONG-LOCAL').confirmedProviderRef, undefined);

            const result = await paymentGatewayService.finalizeFundingCredit({
                transactionStatus: legitimate,
                gatewayPaymentResult: {
                    status: 'success',
                    gateway: 'paystack',
                    reference: 'R18-LEGITIMATE',
                    providerTransactionId: 'PS-R18-ONE-CHARGE',
                    amount: 5000,
                    currency: 'NGN'
                }
            });

            assert.equal(result.settled, true);
            assert.equal(committedRecord('R18-LEGITIMATE').status, 'success');
            assert.equal(financialEffects(), 1);
        });
    } finally {
        mongoose.startSession = originals.startSession;
        TransactionStatus.findOne = originals.statusFindOne;
        TransactionStatus.find = originals.statusFind;
        TransactionStatus.updateOne = originals.statusUpdateOne;
        WalletLedger.findOne = originals.ledgerFindOne;
        walletService.credit = originals.walletCredit;
        investmentService.fulfillSharePurchase = originals.fulfillSharePurchase;
        investmentService.getInvestmentSettings = originals.getInvestmentSettings;
        Transaction.findOne = originals.transactionFindOne;
        Transaction.create = originals.transactionCreate;
        notificationService.sendFundingSuccess = originals.sendFundingSuccess;
    }

    console.log(`\nSettlement integrity batch 3: ${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(error => {
    console.error('[FATAL]', error);
    process.exitCode = 1;
});
