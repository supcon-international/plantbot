// Mirror of adapter-sdk-ts/src/control.ts. Regenerate from dist/control.js when its contract changes.
'use strict'
/** Independent of durable orders. Input replaces input and is never replayed. */
function pumpControl(pb, serial, controller) {
    let ended = false, active, expiresAt = 0, moving = false;
    let lastSequence = -1, stopping, failed = false;
    const ensureStop = async () => {
        if (!active)
            return;
        if (stopping)
            return stopping;
        const frame = active;
        moving = false;
        const pending = controller.stop(frame);
        stopping = pending;
        try {
            await pending;
        }
        finally {
            if (stopping === pending)
                stopping = undefined;
        }
    };
    const reportFailure = async (error) => {
        if (!active)
            return;
        failed = true;
        moving = false;
        await pb.controlStatus(serial, { id: active.id, sequence: active.sequence, status: 'failed', note: error instanceof Error ? error.message : String(error) }).catch(() => { });
    };
    const watchdog = setInterval(() => {
        if (moving && performance.now() >= expiresAt)
            void ensureStop().catch(reportFailure);
    }, 40);
    watchdog.unref();
    const finished = (async () => {
        while (!ended) {
            try {
                const started = performance.now();
                const response = await pb.control(serial);
                if (!response && active)
                    throw new Error('Platform control link lost');
                const frame = response?.frame;
                if (!frame) {
                    if (active) {
                        active = { ...active, status: 'stopping' };
                        await ensureStop();
                        active = undefined;
                        lastSequence = -1;
                    }
                }
                else {
                    if (active && active.id !== frame.id)
                        await ensureStop();
                    if (!active || active.id !== frame.id) {
                        active = frame;
                        lastSequence = -1;
                        failed = false;
                        await controller.start(frame);
                    }
                    active = frame;
                    if (frame.status === 'stopping' || frame.status === 'failed' || failed) {
                        if (failed && !['stopping', 'failed'].includes(frame.status))
                            await reportFailure(new Error('Manual control interrupted; acquire a new session'));
                        await ensureStop();
                        await pb.controlStatus(serial, { id: frame.id, sequence: frame.sequence, status: 'stopped' });
                    }
                    else if (frame.status === 'starting') {
                        await pb.controlStatus(serial, { id: frame.id, sequence: frame.sequence, status: 'ready', position: await controller.position?.(frame) });
                    }
                    else {
                        // Subtract the whole round trip; a delayed response never renews stale input.
                        const remaining = Math.min(350, frame.remainingMs - (performance.now() - started));
                        const nonzero = Object.values(frame.axes).some(x => x !== 0);
                        if (remaining <= 30 || !nonzero) {
                            if (moving)
                                await ensureStop();
                        }
                        else if (frame.sequence > lastSequence) {
                            const deadline = performance.now() + remaining;
                            if (stopping)
                                await stopping;
                            if (!failed && !ended && deadline - performance.now() > 30) {
                                expiresAt = deadline;
                                moving = true;
                                await controller.apply(frame, deadline - performance.now());
                                if (!moving || performance.now() >= expiresAt || ended) {
                                    // A stop sent during a slow apply can precede that command on
                                    // the vendor connection. Stop once more after apply settles.
                                    if (stopping)
                                        await stopping.catch(() => { });
                                    await ensureStop();
                                }
                            }
                        }
                        if (frame.sequence > lastSequence) {
                            lastSequence = frame.sequence;
                            await pb.controlStatus(serial, { id: frame.id, sequence: frame.sequence, status: 'applied', position: await controller.position?.(frame) });
                        }
                    }
                }
            }
            catch (error) {
                await reportFailure(error);
                await ensureStop().catch(() => { });
            }
            if (!ended)
                await new Promise(r => setTimeout(r, 80));
        }
        clearInterval(watchdog);
        await ensureStop();
    })();
    return { stop: async () => { ended = true; await Promise.all([ensureStop(), finished]); }, finished };
}

module.exports = { pumpControl }
