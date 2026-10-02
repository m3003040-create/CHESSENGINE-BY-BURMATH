const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { Chess } = require('../engine/examples/js/chess.min.js');
const { FakeClock } = require('./support/clock');

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

function createHarness() {
    const clock = new FakeClock();
    const sockets = [];
    const workers = [];
    const moves = [];
    const infos = [];
    const fallbacks = [];
    const errors = [];
    const providers = [];
    let readyCount = 0;

    class Socket {
        constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
        send(message) { assert.equal(this.readyState, 1); this.sent.push(JSON.parse(message)); }
        open() { this.readyState = 1; this.onopen?.({}); }
        message(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
        error() { this.onerror?.({ message: 'network unavailable' }); }
        close() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
    }
    class Worker {
        constructor(url) { this.url = url; this.commands = []; this.terminated = false; workers.push(this); }
        postMessage(command) { assert.equal(this.terminated, false); this.commands.push(command); }
        message(data) { this.onmessage?.({ data }); }
        error() { this.onerror?.({ message: 'worker unavailable' }); }
        terminate() { this.terminated = true; }
    }
    const context = {
        window: {}, Worker, WebSocket: Socket, Chess,
        setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock),
        performance: { now: () => clock.now },
        console: { log() {}, warn() {}, error() {} },
    };
    context.window.WebSocket = Socket;
    for (const file of ['bridge.js', 'engine-bridge.js']) {
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context,
            { filename: file });
    }
    const bridge = context.window.Bridge;
    bridge.setCallbacks({
        onBestMove: move => moves.push(move),
        onInfo: info => infos.push(info),
        onProviderFallback: (from, to) => fallbacks.push({ from, to }),
        onError: error => errors.push(error),
        onProvidersChange: state => providers.push(state),
        onReady: () => readyCount++,
    });
    const newWorker = () => workers.filter(worker => worker.url === 'engine/wukong-worker.js').at(-1);
    const localWorkers = () => workers.filter(worker => worker.url.startsWith('engine/stockfish.js'));
    function bootLocal() {
        const worker = localWorkers().at(-1);
        assert.ok(worker, 'the bundled fallback engine is initialized');
        worker.message('uciok');
        worker.message('readyok');
        return worker;
    }
    async function online() {
        const initialization = bridge.init();
        sockets.at(-1).open();
        newWorker().message({ type: 'ready' });
        assert.equal(await initialization, true);
    }
    function search(fen = START, options = {}) {
        bridge.setPosition(fen);
        assert.equal(bridge.startSearch({ movetime: 500, ...options }), true);
    }
    function newRequest() { return newWorker().commands.filter(command => command.type === 'search').at(-1); }
    function newResult(move, request = newRequest(), worker = newWorker()) {
        assert.ok(request, 'the new API receives a search request');
        worker.message({ type: 'bestmove', id: request.id, fen: request.fen, move });
    }
    function oldResult(move, socket = sockets.at(-1), request = socket.sent.at(-1)) {
        assert.ok(request, 'the old API receives a search request');
        socket.message({ ...request, type: 'bestmove', depth: 18, move });
    }
    return {
        bridge, clock, sockets, workers, moves, infos, fallbacks, errors, providers,
        newWorker, localWorkers, bootLocal, online, search, newRequest, newResult, oldResult,
        get readyCount() { return readyCount; },
    };
}

async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); }

test('each API reports its own independent availability and UI name', async () => {
    const h = createHarness();
    const initialized = h.bridge.init();
    assert.deepEqual(Object.keys(h.bridge.getProviders()).sort(), ['new', 'old']);
    h.newWorker().message({ type: 'ready' });
    assert.equal(h.bridge.getProviders().new.connected, true);
    assert.equal(h.bridge.getProviders().old.connected, false);
    assert.equal(h.bridge.getProviders().old.state, 'connecting');
    h.sockets[0].open();
    assert.equal(await initialized, true);
    const providers = h.bridge.getProviders();
    assert.equal(providers.old.name, 'Старый движок Марика');
    assert.equal(providers.new.name, 'Новый движок Марика');
    assert.equal(providers.old.ready, true);
    assert.equal(providers.new.ready, true);
    assert.equal(h.localWorkers().length, 0);
    providers.new.connected = false;
    assert.equal(h.bridge.getProviders().new.connected, true, 'metadata cannot mutate the bridge state');
});

test('a failed old API leaves the new API usable without loading the fallback', async () => {
    const h = createHarness();
    const initialized = h.bridge.init();
    h.sockets[0].error();
    h.newWorker().message({ type: 'ready' });
    assert.equal(await initialized, true);
    assert.equal(h.bridge.getProviders().old.state, 'unavailable');
    assert.equal(h.bridge.getProviders().new.state, 'ready');
    assert.equal(h.bridge.getActiveEngine(), 'new');
    assert.equal(h.localWorkers().length, 0);
    h.search();
    h.newResult('e2e4');
    assert.deepEqual(h.moves, ['e2e4']);
});

test('a failed new API preserves the old API and independently clears its indicator', async () => {
    const h = createHarness();
    const initialized = h.bridge.init();
    h.sockets[0].open();
    h.newWorker().error();
    assert.equal(await initialized, true);
    assert.equal(h.bridge.getProviders().old.connected, true);
    assert.equal(h.bridge.getProviders().new.connected, false);
    assert.equal(h.bridge.getProviders().new.state, 'unavailable');
    assert.equal(h.localWorkers().length, 0);
    h.search();
    h.oldResult('e2e4');
    assert.deepEqual(h.moves, ['e2e4']);
});

test('both unavailable APIs retain the original local engine', async () => {
    const h = createHarness();
    const initialized = h.bridge.init();
    h.sockets[0].error();
    h.newWorker().error();
    await flush();
    const worker = h.bootLocal();
    assert.equal(await initialized, true);
    assert.equal(h.bridge.getActiveEngine(), 'local');
    assert.equal(h.bridge.getEngineReady(), true);
    assert.equal(h.bridge.getProviders().old.connected, false);
    assert.equal(h.bridge.getProviders().new.connected, false);
    h.search(E4);
    assert.ok(worker.commands.includes('position fen ' + E4));
    worker.message('bestmove e7e5');
    assert.deepEqual(h.moves, ['e7e5']);
});

test('selecting the new engine routes moves and progress to its API only', async () => {
    const h = createHarness();
    await h.online();
    assert.equal(h.bridge.setActiveEngine('new'), true);
    h.search(E4);
    assert.equal(h.sockets[0].sent.length, 0);
    const request = h.newRequest();
    assert.equal(request.fen, E4);
    assert.equal(request.movetime, 500);
    h.newWorker().message({ type: 'info', id: request.id, fen: request.fen, info: { depth: 5, score: 10 } });
    assert.equal(h.infos.length, 1);
    assert.equal(h.infos[0].engine, 'new');
    h.newResult('e7e5');
    assert.deepEqual(h.moves, ['e7e5']);
    assert.equal(h.bridge.isSearching(), false);
});

test('a human game continues with the other API when its selected engine disconnects', async () => {
    const h = createHarness();
    await h.online();
    h.search(E4, { engine: 'old' });
    h.sockets[0].close();
    assert.equal(h.newRequest().fen, E4);
    assert.deepEqual(h.fallbacks, [{ from: 'old', to: 'new' }]);
    assert.equal(h.localWorkers().length, 0);
    h.newResult('e7e5');
    assert.deepEqual(h.moves, ['e7e5']);
    assert.equal(h.bridge.getActiveEngine(), 'new');
});

test('an invalid new API result falls back to the old API after validating the searched position', async () => {
    const h = createHarness();
    await h.online();
    h.search(E4, { engine: 'new', validateMove: move => move === 'e7e5' });
    h.newResult('e2e4');
    assert.deepEqual(h.moves, []);
    assert.deepEqual(h.fallbacks, [{ from: 'new', to: 'old' }]);
    assert.equal(h.sockets[0].sent.at(-1).fen, E4);
    h.oldResult('e7e5');
    assert.deepEqual(h.moves, ['e7e5']);
});

test('a human search preserves its position while falling back from both APIs to local', async () => {
    const h = createHarness();
    await h.online();
    h.search(E4, { engine: 'old' });
    h.sockets[0].close();
    const request = h.newRequest();
    h.newWorker().message({ type: 'error', id: request.id, fen: request.fen, error: 'unavailable' });
    const worker = h.bootLocal();
    await flush();
    assert.deepEqual(h.fallbacks, [{ from: 'old', to: 'new' }, { from: 'new', to: 'local' }]);
    assert.ok(worker.commands.includes('position fen ' + E4));
    worker.message('bestmove e7e5');
    assert.deepEqual(h.moves, ['e7e5']);
});

test('arena searches never substitute another API or local engine after failure', async () => {
    for (const engine of ['old', 'new']) {
        const h = createHarness();
        await h.online();
        h.search(E4, { engine, allowFallback: false });
        if (engine === 'old') h.sockets[0].close();
        else h.newWorker().error();
        assert.deepEqual(h.fallbacks, []);
        assert.deepEqual(h.moves, []);
        assert.equal(h.errors.length, 1);
        assert.equal(h.bridge.isSearching(), false);
        assert.equal(h.localWorkers().length, 0);
        if (engine === 'old') assert.equal(h.newRequest(), undefined);
        else assert.equal(h.sockets[0].sent.length, 0);
    }
});

test('cancelling the new API terminates its worker and ignores the old result at the same FEN', async () => {
    const h = createHarness();
    await h.online();
    h.search(START, { engine: 'new' });
    const worker = h.newWorker();
    const cancelled = h.newRequest();
    const lateMessage = worker.onmessage;
    h.bridge.stopSearch();
    assert.equal(worker.terminated, true);
    assert.equal(h.bridge.isSearching(), false);
    h.newWorker().message({ type: 'ready' });
    h.search(START, { engine: 'new' });
    lateMessage({ data: { type: 'bestmove', id: cancelled.id, fen: START, move: 'e2e4' } });
    assert.deepEqual(h.moves, []);
    h.newResult('d2d4');
    assert.deepEqual(h.moves, ['d2d4']);
});

test('foreign worker request IDs and positions cannot complete an active calculation', async () => {
    const h = createHarness();
    await h.online();
    h.search(E4, { engine: 'new' });
    const request = h.newRequest();
    h.newWorker().message({ type: 'bestmove', id: request.id + 1, fen: E4, move: 'e7e5' });
    h.newWorker().message({ type: 'bestmove', id: request.id, fen: START, move: 'e2e4' });
    assert.deepEqual(h.moves, []);
    assert.equal(h.bridge.isSearching(), true);
    h.newResult('e7e5');
    assert.deepEqual(h.moves, ['e7e5']);
});

test('the new API receives the final FEN when a position includes a move sequence', async () => {
    const h = createHarness();
    await h.online();
    h.bridge.setPosition(START, ['e2e4']);
    h.bridge.startSearch({ engine: 'new' });
    assert.equal(h.newRequest().fen, E4.replace(' - 0 1', ' e3 0 1'));
    h.newResult('e7e5');
    assert.deepEqual(h.moves, ['e7e5']);
});

test('a new API timeout stops its worker and bounds failure in arena mode', async () => {
    const h = createHarness();
    await h.online();
    h.search(START, { engine: 'new', movetime: 500, allowFallback: false });
    const worker = h.newWorker();
    h.clock.tick(2499);
    assert.equal(h.errors.length, 0);
    h.clock.tick(1);
    assert.equal(h.errors.length, 1);
    assert.equal(worker.terminated, true);
    assert.equal(h.bridge.getProviders().new.connected, false);
    assert.equal(h.bridge.getProviders().old.connected, true);
    assert.deepEqual(h.fallbacks, []);
});

test('an explicitly selected local engine remains local even when both APIs are available', async () => {
    const h = createHarness();
    await h.online();
    h.search(E4, { engine: 'local' });
    const worker = h.bootLocal();
    await flush();
    assert.equal(h.sockets[0].sent.length, 0);
    assert.equal(h.newRequest(), undefined);
    assert.ok(worker.commands.includes('position fen ' + E4));
    worker.message('bestmove e7e5');
    assert.deepEqual(h.moves, ['e7e5']);
});

test('a search can initialize the APIs and waits for the requested provider', async () => {
    const h = createHarness();
    h.search(E4, { engine: 'new' });
    assert.equal(h.newRequest(), undefined);
    h.sockets[0].open();
    h.newWorker().message({ type: 'ready' });
    await flush();
    assert.equal(h.localWorkers().length, 0);
    assert.equal(h.newRequest().fen, E4);
    h.newResult('e7e5');
    assert.deepEqual(h.moves, ['e7e5']);
});

test('a search submitted while the API checks run waits instead of loading a fallback', async () => {
    const h = createHarness();
    const initialized = h.bridge.init();
    h.search(E4, { engine: 'new' });
    h.newWorker().message({ type: 'ready' });
    h.sockets[0].open();
    await initialized;
    await flush();
    assert.equal(h.localWorkers().length, 0);
    assert.equal(h.newRequest().fen, E4);
    h.newResult('e7e5');
    assert.deepEqual(h.moves, ['e7e5']);
});

test('a local-only new game clears readiness until its existing worker finishes reset', async () => {
    const h = createHarness();
    const initialized = h.bridge.init();
    h.sockets[0].error();
    h.newWorker().error();
    await flush();
    const worker = h.bootLocal();
    await initialized;
    const resetting = h.bridge.newGame();
    assert.equal(h.bridge.getEngineReady('local'), false);
    assert.ok(worker.commands.includes('ucinewgame'));
    h.sockets.at(-1).error();
    h.newWorker().error();
    await flush();
    let resetFinished = false;
    resetting.then(() => { resetFinished = true; });
    await flush();
    assert.equal(resetFinished, false);
    worker.message('readyok');
    assert.equal(await resetting, true);
    assert.equal(h.bridge.getEngineReady('local'), true);
    h.search(E4);
    worker.message('bestmove e7e5');
    assert.deepEqual(h.moves, ['e7e5']);
});
