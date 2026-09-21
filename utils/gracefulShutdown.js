const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

function createGracefulShutdown({
    getServer,
    cron,
    mongoose,
    timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    cronTimeoutMs = timeoutMs + 5_000,
    exit = code => process.exit(code),
    logger = console,
    setTimer = setTimeout,
    clearTimer = clearTimeout
}) {
    let shuttingDown = false;
    let shutdownPromise = null;
    let requestedExitCode = null;

    const requestExit = code => {
        if (requestedExitCode !== null) return;
        requestedExitCode = code;
        exit(code);
    };

    const closeHttpServer = () => {
        const server = getServer();
        if (!server) return Promise.resolve();

        return new Promise((resolve, reject) => {
            const done = error => {
                if (!error || error.code === 'ERR_SERVER_NOT_RUNNING') {
                    resolve();
                    return;
                }
                reject(error);
            };

            try {
                server.close(done);
            } catch (error) {
                done(error);
            }
        });
    };

    const shutdown = signal => {
        if (shutdownPromise) return shutdownPromise;

        shuttingDown = true;
        shutdownPromise = (async () => {
            logger.log(`[Shutdown] ${signal} received; draining HTTP and cron work...`);

            const hardTimer = setTimer(() => {
                logger.error(`[Shutdown] Timed out after ${timeoutMs}ms`);
                requestExit(1);
            }, timeoutMs);

            let failed = false;
            let cronDrain;
            try {
                // node-cron stops future ticks synchronously before waiting for busy tasks.
                cronDrain = Promise.resolve(cron.shutdown(cronTimeoutMs));
            } catch (error) {
                cronDrain = Promise.reject(error);
            }

            const results = await Promise.allSettled([
                cronDrain,
                closeHttpServer()
            ]);

            for (const result of results) {
                if (result.status === 'rejected') {
                    failed = true;
                    logger.error('[Shutdown] Drain failed:', result.reason);
                }
            }

            if (requestedExitCode !== null) return requestedExitCode;

            try {
                await mongoose.disconnect();
            } catch (error) {
                failed = true;
                logger.error('[Shutdown] MongoDB disconnect failed:', error);
            }

            if (requestedExitCode !== null) return requestedExitCode;

            clearTimer(hardTimer);
            const exitCode = failed ? 1 : 0;
            requestExit(exitCode);
            return exitCode;
        })();

        return shutdownPromise;
    };

    return {
        shutdown,
        isShuttingDown: () => shuttingDown,
        getShutdownPromise: () => shutdownPromise
    };
}

function registerShutdownSignals({ processRef = process, shutdown }) {
    const onSigterm = () => { void shutdown('SIGTERM'); };
    const onSigint = () => { void shutdown('SIGINT'); };

    processRef.on('SIGTERM', onSigterm);
    processRef.on('SIGINT', onSigint);

    return () => {
        processRef.off('SIGTERM', onSigterm);
        processRef.off('SIGINT', onSigint);
    };
}

module.exports = {
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    createGracefulShutdown,
    registerShutdownSignals
};
