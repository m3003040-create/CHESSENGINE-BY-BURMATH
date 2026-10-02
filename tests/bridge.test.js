const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

class FakeClock {
    constructor() {
        this.now = 0;
        this.nextId = 1;
        this.timers = new Map();
    }

    setTimeout(callback, delay = 0, ...args) {
        const id = this.nextId++;
        this.timers.set(id, { at: this.now + Math.max(0, delay), callback, args });
        return id;
    }

    clearTimeout(id) { this.timers.delete(id); }

    tick(milliseconds) {
        const target = this.now + milliseconds;
        for (;;) {
            const pending = [...this.timers.entries()]
                .filter(([, timer]) => timer.at <= target)
                .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
            if (!pending) break;
            const [id, timer] = pending;
            this.now = timer.at;
            this.timers.delete(id);
            timer.callback(...timer.args);
        }
        this.now = target;
    }
}

function createHarness({ webSocketAvailable = true } = {}) {
    const clock = new FakeClock();
    const sockets = [];
    const workers = [];
    const moves = [];
    const infos = [];
    const connections = [];
    const errors = [];
    let readyCount = 0;

    class MockWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        constructor(url) {
            this.url = url;
            this.readyState = MockWebSocket.CONNECTING;
            this.CONNECTING = MockWebSocket.CONNECTING;
            this.OPEN = MockWebSocket.OPEN;
            this.CLOSING = MockWebSocket.CLOSING;
            this.CLOSED = MockWebSocket.CLOSED;
            this.sent = [];
            sockets.push(this);
        }

        send(message) {
            assert.equal(this.readyState, MockWebSocket.OPEN, 'send requires an open socket');
            this.sent.push(JSON.parse(message));
        }

        open() {
            this.readyState = MockWebSocket.OPEN;
            this.onopen?.({});
        }

        message(data) { this.onmessage?.({ data: JSON.stringify(data) }); }

        error() { this.onerror?.({ message: 'network unavailable' }); }

        close() {
            this.readyState = MockWebSocket.CLOSED;
            this.onclose?.({ code: 1006 });
        }
    }

    class MockWorker {
        constructor(url) {
            this.url = url;
            this.commands = [];
            this.terminated = false;
            workers.push(this);
        }

        postMessage(command) {
            assert.equal(this.terminated, false, 'commands must not reach a terminated worker');
            this.commands.push(command);
        }

        message(data) { this.onmessage?.({ data }); }
        terminate() { this.terminated = true; }
    }

    const context = {
        window: {},
        Worker: MockWorker,
        WebSocket: webSocketAvailable ? MockWebSocket : undefined,
        setTimeout: clock.setTimeout.bind(clock),
        clearTimeout: clock.clearTimeout.bind(clock),
        performance: { now: () => clock.now },
        console: { log() {}, warn() {}, error() {} },
    };
    context.window.WebSocket = context.WebSocket;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8'), context,
        { filename: 'bridge.js' });
    const bridge = context.window.Bridge;
    bridge.setCallbacks({
        onReady: () => readyCount++,
        onBestMove: move => moves.push(move),
        onInfo: info => infos.push(info),
        onConnectionChange: (connected, state) => connections.push({ connected, state }),
        onError: error => errors.push(error),
    });

    function bootLocal() {
        const worker = workers.at(-1);
        assert.ok(worker, 'fallback creates the existing local Stockfish worker');
        worker.message('uciok');
        worker.message('readyok');
        return worker;
    }

    function online(options) {
        bridge.init(options);
        const socket = sockets.at(-1);
        socket.open();
        return socket;
    }

    function local() {
        bridge.init();
        sockets.at(-1)?.error();
        return bootLocal();
    }

    function search(fen = START_FEN, options = {}) {
        bridge.setPosition(fen);
        bridge.startSearch({ movetime: 1000, ...options });
        return sockets.at(-1)?.sent.at(-1);
    }

    function result(socket, request, move = 'e2e4', extra = {}) {
        socket.message({ ...request, type: 'bestmove', move, depth: 18, ...extra });
    }

    return {
        bridge, clock, sockets, workers, moves, infos, connections, errors, bootLocal, online, local,
        search, result, get readyCount() { return readyCount; },
    };
}

async function flushPromises() {
    await Promise.resolve();
    await Promise.resolve();
}

test('online startup uses chess-api without downloading the local engine', () => {
    const h = createHarness();
    const socket = h.online();
    assert.equal(socket.url, 'wss://chess-api.com/v1');
    assert.equal(h.workers.length, 0);
    assert.equal(h.bridge.getEngineReady(), true);
    assert.equal(h.bridge.getRemoteConnected(), true);
    assert.equal(h.bridge.getConnectionState(), 'remote');
    assert.equal(h.readyCount, 1);
    assert.deepEqual(h.connections.at(-1), { connected: true, state: 'remote' });
});

test('failed startup preserves the old local Worker and strength settings', () => {
    const h = createHarness();
    const worker = h.local();
    assert.match(worker.url, /^engine\/stockfish\.js#/);
    assert.equal(h.bridge.getRemoteConnected(), false);
    assert.equal(h.bridge.getConnectionState(), 'local');
    assert.equal(h.bridge.getEngineReady(), true);
    for (const command of [
        'uci', 'setoption name Skill Level value 20', 'setoption name Threads value 1',
        'setoption name Hash value 32', 'setoption name Ponder value false', 'isready',
    ]) assert.ok(worker.commands.includes(command), command);
    h.search(AFTER_E4, { wtime: 900000, btime: 800000 });
    assert.ok(worker.commands.includes('position fen ' + AFTER_E4));
    assert.ok(worker.commands.includes('go wtime 900000 btime 800000'));
    worker.message('bestmove e7e5 ponder g1f3');
    assert.deepEqual(h.moves, ['e7e5']);
});

test('connection timeout switches local and ignores a late socket open', () => {
    const h = createHarness();
    h.bridge.init();
    const timedOut = h.sockets[0];
    h.clock.tick(2499);
    assert.equal(h.workers.length, 0);
    h.clock.tick(1);
    h.bootLocal();
    timedOut.open();
    assert.equal(h.bridge.getRemoteConnected(), false);
    assert.equal(h.bridge.getConnectionState(), 'local');
    assert.equal(h.workers.length, 1);
});

test('a browser without WebSocket can still start the local engine', () => {
    const h = createHarness({ webSocketAvailable: false });
    h.local();
    assert.equal(h.bridge.getEngineReady(), true);
    assert.equal(h.bridge.getConnectionState(), 'local');
});

test('remote search requests one strong, time-limited variation for the current FEN', () => {
    const h = createHarness();
    const socket = h.online();
    const request = h.search(AFTER_E4, { wtime: 900000, btime: 800000 });
    assert.equal(request.fen, AFTER_E4);
    assert.equal(request.depth, 18);
    assert.equal(request.variants, 1);
    assert.equal(request.maxThinkingTime, 100);
    assert.equal(typeof request.taskId, 'string');
    h.result(socket, request, 'e7e5');
    assert.deepEqual(h.moves, ['e7e5']);
    assert.equal(h.bridge.isSearching(), false);
    h.clock.tick(2000);
    assert.deepEqual(h.moves, ['e7e5'], 'a finished search cannot also finish at its deadline');
});

test('a stalled remote search falls back locally at the bounded deadline', () => {
    const h = createHarness();
    h.online();
    h.search(AFTER_E4, { wtime: 900000, btime: 800000 });
    h.clock.tick(1799);
    assert.equal(h.workers.length, 0);
    h.clock.tick(1);
    const worker = h.bootLocal();
    assert.ok(worker.commands.includes('position fen ' + AFTER_E4));
    assert.ok(worker.commands.includes('go wtime 900000 btime 800000'));
    worker.message('bestmove e7e5');
    assert.deepEqual(h.moves, ['e7e5']);
    assert.equal(h.bridge.getRemoteConnected(), false);
});

test('the best legal progressive result completes once at the remote deadline', () => {
    const h = createHarness();
    const socket = h.online();
    const request = h.search(START_FEN, { validateMove: move => ['e2e4', 'd2d4'].includes(move) });
    socket.message({ ...request, type: 'move', move: 'e2e4', depth: 12, eval: 0.25, pv: 'e2e4 e7e5' });
    socket.message({ ...request, type: 'move', move: 'd2d4', depth: 16, eval: 0.3, pv: 'd2d4 d7d5' });
    socket.message({ ...request, type: 'move', move: 'e2e4', depth: 10 });
    assert.deepEqual(h.moves, []);
    h.clock.tick(1800);
    assert.deepEqual(h.moves, ['d2d4']);
    assert.equal(h.bridge.isSearching(), false);
    assert.equal(h.workers.length, 0);
    assert.ok(h.infos.length >= 1);
    h.result(socket, request, 'e2e4');
    assert.deepEqual(h.moves, ['d2d4']);
});

test('an illegal remote result falls back and never reaches the game callback', () => {
    const h = createHarness();
    const socket = h.online();
    const request = h.search(AFTER_E4, { validateMove: move => move === 'e7e5' });
    h.result(socket, request, 'e2e4');
    assert.deepEqual(h.moves, []);
    const worker = h.bootLocal();
    assert.ok(worker.commands.includes('position fen ' + AFTER_E4));
    worker.message('bestmove e7e5');
    assert.deepEqual(h.moves, ['e7e5']);
});

test('disconnecting during a search resumes the same position locally', () => {
    const h = createHarness();
    const socket = h.online();
    const request = h.search(AFTER_E4);
    socket.close();
    const worker = h.bootLocal();
    assert.ok(worker.commands.includes('position fen ' + AFTER_E4));
    h.result(socket, request, 'e7e5');
    assert.deepEqual(h.moves, [], 'the disconnected service cannot play a stale move');
    worker.message('bestmove e7e5');
    assert.deepEqual(h.moves, ['e7e5']);
    assert.equal(h.bridge.getRemoteConnected(), false);
});

test('responses for another task or another position cannot end the current search', () => {
    const h = createHarness();
    const socket = h.online();
    const request = h.search(START_FEN);
    h.result(socket, request, 'e2e4', { fen: AFTER_E4 });
    // The actual service assigns its own task ID instead of echoing ours.
    socket.message({ ...request, taskId: 'server-assigned-task', type: 'move', move: 'e2e4', depth: 12 });
    h.result(socket, request, 'e2e4', { taskId: 'another-task' });
    assert.deepEqual(h.moves, []);
    assert.equal(h.bridge.isSearching(), true);
    h.result(socket, request, 'e2e4', { taskId: 'server-assigned-task' });
    assert.deepEqual(h.moves, ['e2e4']);
});

test('per-search callbacks keep a hint from playing an engine move', () => {
    const h = createHarness();
    const socket = h.online();
    const hints = [];
    const hintRequest = h.search(START_FEN, { onBestMove: move => hints.push(move) });
    h.result(socket, hintRequest);
    assert.deepEqual(hints, ['e2e4']);
    assert.deepEqual(h.moves, []);
    const replyRequest = h.search(AFTER_E4);
    h.result(socket, replyRequest, 'e7e5');
    assert.deepEqual(h.moves, ['e7e5']);
    assert.deepEqual(hints, ['e2e4']);
});

test('new game cancels the old socket and rejects results from the previous game', async () => {
    const h = createHarness();
    const oldSocket = h.online();
    const oldRequest = h.search(START_FEN);
    const ready = h.bridge.newGame();
    const newSocket = h.sockets.at(-1);
    assert.notEqual(newSocket, oldSocket, 'a cancelled calculation requires a fresh socket');
    h.result(oldSocket, oldRequest);
    assert.deepEqual(h.moves, []);
    newSocket.open();
    assert.equal(await ready, true);
    const request = h.search(START_FEN);
    assert.notEqual(request.taskId, oldRequest.taskId);
    h.result(oldSocket, oldRequest);
    assert.deepEqual(h.moves, []);
    h.result(newSocket, request, 'd2d4');
    assert.deepEqual(h.moves, ['d2d4']);
});

test('completed server tasks cannot contaminate a repeated position on a reused socket', async () => {
    const h = createHarness();
    const socket = h.online();
    const first = h.search(START_FEN);
    h.result(socket, first, 'e2e4', { taskId: 'server-task-1' });
    assert.equal(await h.bridge.newGame(), true);
    assert.equal(h.sockets.length, 1, 'an idle open connection remains available');
    const second = h.search(START_FEN);
    h.result(socket, first, 'e2e4', { taskId: 'server-task-1' });
    assert.deepEqual(h.moves, ['e2e4']);
    assert.equal(h.bridge.isSearching(), true);
    h.result(socket, second, 'd2d4', { taskId: 'server-task-2' });
    assert.deepEqual(h.moves, ['e2e4', 'd2d4']);
});

test('local cancellation drains the old bestmove before starting another search', () => {
    const h = createHarness();
    const worker = h.local();
    h.search(START_FEN);
    const firstGoCount = worker.commands.filter(command => command.startsWith('go ')).length;
    h.bridge.stopSearch();
    assert.equal(worker.commands.at(-1), 'stop');
    h.search(AFTER_E4);
    assert.equal(worker.commands.filter(command => command.startsWith('go ')).length, firstGoCount);
    worker.message('bestmove e2e4');
    assert.deepEqual(h.moves, []);
    assert.ok(worker.commands.includes('position fen ' + AFTER_E4));
    assert.equal(worker.commands.filter(command => command.startsWith('go ')).length, firstGoCount + 1);
    worker.message('bestmove e7e5');
    assert.deepEqual(h.moves, ['e7e5']);
});

test('new game waits for local cancellation and readiness after failed reconnect', async () => {
    const h = createHarness();
    const worker = h.local();
    h.search(START_FEN);
    const ready = h.bridge.newGame();
    h.sockets.at(-1).error();
    assert.equal(worker.commands.includes('ucinewgame'), false);
    worker.message('bestmove e2e4');
    await flushPromises();
    assert.deepEqual(h.moves, []);
    assert.ok(worker.commands.includes('ucinewgame'));
    assert.equal(h.bridge.getEngineReady(), false);
    worker.message('readyok');
    assert.equal(await ready, true);
    assert.equal(h.bridge.getEngineReady(), true);
});

test('a service error without task metadata immediately resumes the position locally', () => {
    const h = createHarness();
    const socket = h.online();
    h.search(AFTER_E4);
    socket.message({ type: 'error', error: 'Service unavailable' });
    const worker = h.bootLocal();
    assert.ok(worker.commands.includes('position fen ' + AFTER_E4));
    worker.message('bestmove e7e5');
    assert.deepEqual(h.moves, ['e7e5']);
});

test('a metadata-free service error after a progressive result also falls back', () => {
    const h = createHarness();
    const socket = h.online();
    const request = h.search(AFTER_E4);
    socket.message({ ...request, taskId: 'server-task', type: 'move', move: 'e7e5', depth: 12 });
    socket.message({ type: 'error', error: 'Calculation failed' });
    assert.equal(h.bridge.getRemoteConnected(), false);
    const worker = h.bootLocal();
    assert.ok(worker.commands.includes('position fen ' + AFTER_E4));
    worker.message('bestmove e7e5');
    assert.deepEqual(h.moves, ['e7e5']);
});

test('a fallback notification does not advertise readiness before the local engine loads', () => {
    const h = createHarness();
    const socket = h.online();
    let readyDuringFallback;
    h.bridge.setCallbacks({
        onConnectionChange(_connected, state) {
            if (state === 'local') readyDuringFallback = h.bridge.getEngineReady();
        },
    });
    socket.close();
    assert.equal(readyDuringFallback, false);
    h.bootLocal();
    assert.equal(h.bridge.getEngineReady(), true);
});

test('an unresponsive local stop restarts the worker and ignores its late bestmove', () => {
    const h = createHarness();
    const oldWorker = h.local();
    h.search(START_FEN);
    h.bridge.stopSearch();
    h.search(AFTER_E4);
    h.clock.tick(1500);
    assert.equal(oldWorker.terminated, true);
    assert.equal(h.workers.length, 2);
    const worker = h.bootLocal();
    assert.ok(worker.commands.includes('position fen ' + AFTER_E4));
    oldWorker.message('bestmove e2e4');
    assert.deepEqual(h.moves, []);
    worker.message('bestmove e7e5');
    assert.deepEqual(h.moves, ['e7e5']);
});

test('local initialization failure resolves a new game instead of hanging forever', async () => {
    const h = createHarness();
    const ready = h.bridge.newGame();
    h.sockets.at(-1).error();
    h.clock.tick(45000);
    assert.equal(await ready, false);
    assert.equal(h.bridge.getEngineReady(), false);
    assert.equal(h.bridge.getConnectionState(), 'error');
    assert.equal(h.bridge.getRemoteConnected(), false);
    assert.equal(h.errors.length, 1);
});

test('a reused local worker that never answers isready times out the new game', async () => {
    const h = createHarness();
    const worker = h.local();
    const ready = h.bridge.newGame();
    h.sockets.at(-1).error();
    assert.ok(worker.commands.includes('ucinewgame'));
    let outcome = 'pending';
    ready.then(value => { outcome = value; });
    h.clock.tick(45000);
    await flushPromises();
    assert.equal(outcome, false, 'reset must resolve even if an existing engine stops answering');
    assert.equal(worker.terminated, true);
    assert.equal(h.bridge.getConnectionState(), 'error');
    assert.equal(h.errors.length, 1);
});

test('an arena disconnect reports failure without substituting the local engine', () => {
    const h = createHarness();
    const socket = h.online({ remoteOnly: true });
    const failures = [];
    const request = h.search(AFTER_E4, {
        allowFallback: false,
        onError: error => failures.push(error),
    });
    socket.close();
    h.result(socket, request, 'e7e5');
    h.clock.tick(10000);
    assert.equal(h.workers.length, 0);
    assert.deepEqual(h.moves, []);
    assert.equal(failures.length, 1);
    assert.equal(h.bridge.isSearching(), false);
});

test('an invalid arena move cannot resume the search with the local engine', () => {
    const h = createHarness();
    const socket = h.online({ remoteOnly: true });
    const failures = [];
    const request = h.search(AFTER_E4, {
        allowFallback: false,
        validateMove: move => move === 'e7e5',
        onError: error => failures.push(error),
    });
    h.result(socket, request, 'e2e4');
    assert.equal(h.workers.length, 0);
    assert.deepEqual(h.moves, []);
    assert.equal(failures.length, 1);
    assert.equal(h.bridge.isSearching(), false);
});
