'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const {
    createGracefulShutdown,
    registerShutdownSignals
} = require('../utils/gracefulShutdown');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function createHarness({ server, cronShutdown, disconnect } = {}) {
    const exits = [];
    const logs = [];
    let timerCallback = null;
    let timerDelay = null;
    let timerCleared = false;

    const lifecycle = createGracefulShutdown({
        getServer: () => server || {
            close(callback) { callback(); }
        },
        cron: {
            shutdown: cronShutdown || (async () => {})
        },
        mongoose: {
            disconnect: disconnect || (async () => {})
        },
        exit: code => exits.push(code),
        logger: {
            log: (...args) => logs.push(['log', ...args]),
            error: (...args) => logs.push(['error', ...args])
        },
        setTimer: (callback, delay) => {
            timerCallback = callback;
            timerDelay = delay;
            return { callback };
        },
        clearTimer: () => {
            timerCleared = true;
        }
    });

    return {
        lifecycle,
        exits,
        logs,
        getTimerCallback: () => timerCallback,
        getTimerDelay: () => timerDelay,
        isTimerCleared: () => timerCleared
    };
}

for (const signal of ['SIGTERM', 'SIGINT']) {
    test(`${signal} initiates graceful shutdown`, async () => {
        const processRef = new EventEmitter();
        let closeCalls = 0;
        let cronCalls = 0;
        let disconnectCalls = 0;
        const harness = createHarness({
            server: {
                close(callback) {
                    closeCalls++;
                    callback();
                }
            },
            cronShutdown: async () => { cronCalls++; },
            disconnect: async () => { disconnectCalls++; }
        });
        const unregister = registerShutdownSignals({
            processRef,
            shutdown: harness.lifecycle.shutdown
        });

        processRef.emit(signal);
        await harness.lifecycle.getShutdownPromise();
        unregister();

        assert.equal(closeCalls, 1);
        assert.equal(cronCalls, 1);
        assert.equal(disconnectCalls, 1);
        assert.deepEqual(harness.exits, [0]);
    });
}

test('repeated and mixed signals execute cleanup once', async () => {
    const processRef = new EventEmitter();
    const httpDrain = deferred();
    const cronDrain = deferred();
    let closeCalls = 0;
    let cronCalls = 0;
    let disconnectCalls = 0;
    const harness = createHarness({
        server: {
            close(callback) {
                closeCalls++;
                void httpDrain.promise.then(() => callback());
            }
        },
        cronShutdown: () => {
            cronCalls++;
            return cronDrain.promise;
        },
        disconnect: async () => { disconnectCalls++; }
    });
    const unregister = registerShutdownSignals({
        processRef,
        shutdown: harness.lifecycle.shutdown
    });

    processRef.emit('SIGTERM');
    processRef.emit('SIGTERM');
    processRef.emit('SIGINT');
    assert.equal(closeCalls, 1);
    assert.equal(cronCalls, 1);

    httpDrain.resolve();
    cronDrain.resolve();
    await harness.lifecycle.getShutdownPromise();
    unregister();

    assert.equal(disconnectCalls, 1);
    assert.deepEqual(harness.exits, [0]);
});

test('server.close starts immediately and MongoDB waits for HTTP and cron drains', async () => {
    const events = [];
    const httpDrain = deferred();
    const cronDrain = deferred();
    const harness = createHarness({
        server: {
            close(callback) {
                events.push('http-close-start');
                void httpDrain.promise.then(() => {
                    events.push('http-drained');
                    callback();
                });
            }
        },
        cronShutdown: () => {
            events.push('cron-shutdown-start');
            return cronDrain.promise.then(() => events.push('cron-drained'));
        },
        disconnect: async () => { events.push('mongoose-disconnect'); }
    });

    const shutdownPromise = harness.lifecycle.shutdown('SIGTERM');
    assert.ok(events.includes('http-close-start'));
    assert.ok(events.includes('cron-shutdown-start'));
    assert.ok(!events.includes('mongoose-disconnect'));

    httpDrain.resolve();
    await flush();
    assert.ok(!events.includes('mongoose-disconnect'));

    cronDrain.resolve();
    await shutdownPromise;
    assert.ok(events.indexOf('mongoose-disconnect') > events.indexOf('http-drained'));
    assert.ok(events.indexOf('mongoose-disconnect') > events.indexOf('cron-drained'));
    assert.deepEqual(harness.exits, [0]);
    assert.equal(harness.getTimerDelay(), 30_000);
    assert.equal(harness.isTimerCleared(), true);
});

test('new HTTP connections are refused while an accepted slow request finishes', async () => {
    const accepted = deferred();
    const releaseResponse = deferred();
    const exits = [];
    let timerCleared = false;

    const server = http.createServer(async (req, res) => {
        accepted.resolve();
        await releaseResponse.promise;
        res.end('finished');
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const firstResponse = new Promise((resolve, reject) => {
        const request = http.get({
            host: '127.0.0.1',
            port: address.port,
            path: '/',
            agent: false
        }, response => {
            response.resume();
            response.once('end', resolve);
        });
        request.once('error', reject);
    });
    await accepted.promise;

    const lifecycle = createGracefulShutdown({
        getServer: () => server,
        cron: { shutdown: async () => {} },
        mongoose: { disconnect: async () => {} },
        exit: code => exits.push(code),
        logger: { log() {}, error() {} },
        setTimer: callback => ({ callback }),
        clearTimer: () => { timerCleared = true; }
    });
    const shutdownPromise = lifecycle.shutdown('SIGTERM');
    await flush();

    assert.equal(server.listening, false);
    await assert.rejects(new Promise((resolve, reject) => {
        const request = http.get({
            host: '127.0.0.1',
            port: address.port,
            path: '/',
            agent: false
        }, response => {
            response.resume();
            response.once('end', resolve);
        });
        request.once('error', reject);
    }));

    releaseResponse.resolve();
    await firstResponse;
    await shutdownPromise;

    assert.deepEqual(exits, [0]);
    assert.equal(timerCleared, true);
});

test('cleanup failure disconnects MongoDB and exits 1', async () => {
    let disconnectCalls = 0;
    const harness = createHarness({
        server: {
            close(callback) {
                callback(new Error('close failed'));
            }
        },
        disconnect: async () => { disconnectCalls++; }
    });

    const result = await harness.lifecycle.shutdown('SIGTERM');

    assert.equal(result, 1);
    assert.equal(disconnectCalls, 1);
    assert.deepEqual(harness.exits, [1]);
});

test('hard timeout forces one exit 1 even if cleanup later completes', async () => {
    const httpDrain = deferred();
    const cronDrain = deferred();
    const harness = createHarness({
        server: {
            close(callback) {
                void httpDrain.promise.then(() => callback());
            }
        },
        cronShutdown: () => cronDrain.promise
    });

    const shutdownPromise = harness.lifecycle.shutdown('SIGTERM');
    harness.getTimerCallback()();
    assert.deepEqual(harness.exits, [1]);

    httpDrain.resolve();
    cronDrain.resolve();
    const result = await shutdownPromise;

    assert.equal(result, 1);
    assert.deepEqual(harness.exits, [1]);
});

test('shutdown state prevents listener and cron startup after a pending connection resolves', async () => {
    const connection = deferred();
    let listenCalls = 0;
    let cronStarts = 0;
    const harness = createHarness();

    const boot = connection.promise.then(() => {
        if (harness.lifecycle.isShuttingDown()) return;
        listenCalls++;
        cronStarts++;
    });

    await harness.lifecycle.shutdown('SIGTERM');
    connection.resolve();
    await boot;

    assert.equal(listenCalls, 0);
    assert.equal(cronStarts, 0);

    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const guardIndex = serverSource.indexOf('if (gracefulShutdown.isShuttingDown()) return;');
    const listenIndex = serverSource.indexOf('server = app.listen');
    const cronIndex = serverSource.indexOf('startDividendCron();');
    assert.ok(guardIndex >= 0 && guardIndex < listenIndex && listenIndex < cronIndex);
});

test('MongoDB startup failure behavior remains exit 1 outside shutdown', () => {
    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(serverSource, /\.catch\(\(err\) => \{[\s\S]*if \(gracefulShutdown\.isShuttingDown\(\)\) return;[\s\S]*process\.exit\(1\)/);
});

test('detached promises remain outside the guaranteed shutdown drain', async () => {
    const detached = deferred();
    let detachedFinished = false;
    void detached.promise.then(() => { detachedFinished = true; });
    const harness = createHarness();

    await harness.lifecycle.shutdown('SIGTERM');

    assert.deepEqual(harness.exits, [0]);
    assert.equal(detachedFinished, false);
    detached.resolve();
    await flush();
    assert.equal(detachedFinished, true);
});
