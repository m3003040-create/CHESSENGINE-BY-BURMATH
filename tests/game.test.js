const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { FakeClock } = require('./support/clock');

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const E4_ENGINE = E4.replace(' e3 ', ' - ');
const E4_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
const E4_E5_NF3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';
const EN_PASSANT = '4k3/8/8/8/3pP3/8/8/4K3 b - e3 0 1';
const PINNED_EN_PASSANT = 'k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 1';

// The chess rules are an external library. This small opening fixture models its
// move/undo contract so these tests exercise game lifecycle and callbacks only.
class OpeningChess {
    constructor(fen = START) { this.load(fen); }
    load(fen) { this.position = fen; this._history = []; return true; }
    fen() { return this.position; }
    history() { return this._history.map(entry => entry.move.san); }
    turn() { return this.position.split(' ')[1]; }
    moves() { return this.position === EN_PASSANT ? [{ flags: 'e' }] : []; }
    get(square) {
        if (square === 'e2' && this.position === START) return { type: 'p', color: 'w' };
        if (square === 'e7' && this.position === E4) return { type: 'p', color: 'b' };
        if (square === 'g1' && this.position === E4_E5) return { type: 'n', color: 'w' };
        return null;
    }
    move({ from, to }) {
        const opening = {
            [START]: ['e2', 'e4', E4, 'e4', 'p'],
            [E4]: ['e7', 'e5', E4_E5, 'e5', 'p'],
            [E4_E5]: ['g1', 'f3', E4_E5_NF3, 'Nf3', 'n'],
        };
        const expected = opening[this.position];
        if (!expected || from !== expected[0] || to !== expected[1]) return null;
        const move = { from, to, san: expected[3], piece: expected[4], flags: 'n' };
        this._history.push({ fen: this.position, move });
        this.position = expected[2];
        return move;
    }
    undo() {
        const last = this._history.pop();
        if (!last) return null;
        this.position = last.fen;
        return last.move;
    }
    in_checkmate() { return false; }
    in_stalemate() { return false; }
    in_threefold_repetition() { return false; }
    insufficient_material() { return false; }
    in_draw() { return false; }
    in_check() { return false; }
}

function createHarness({ playerColor = 'white', ready = true, immediateMove, gameEndsAfter } = {}) {
    const clock = new FakeClock();
    const searches = [];
    const events = [];
    const highlights = [];
    const historyMoves = [];
    const positions = [];
    let boardConfig;
    const resetResolvers = [];
    let historyInitialized = false;
    const bridge = {
        callbacks: {},
        ready,
        activeEngine: 'old',
        providers: {
            old: { id: 'old', name: 'Старый движок Марика', ready: true, connected: true, state: 'ready' },
            new: { id: 'new', name: 'Новый движок Марика', ready: true, connected: true, state: 'ready' },
        },
        setCallbacks(callbacks) { Object.assign(this.callbacks, callbacks); },
        getEngineReady(id) { return this.ready && (!id || id === 'local' || this.providers[id]?.ready); },
        getProviders() { return this.providers; },
        getActiveEngine() { return this.activeEngine; },
        setActiveEngine(id) { this.activeEngine = id; return true; },
        getRemoteConnected() { return true; },
        getConnectionState() { return 'remote'; },
        setPosition(fen) { this.fen = fen; },
        startSearch(options) {
            events.push('search');
            searches.push({ fen: this.fen, options });
            if (immediateMove) options.onBestMove(immediateMove);
        },
        stopSearch() { events.push('stop'); },
        newGame() {
            events.push('newGame');
            this.ready = false;
            return new Promise(resolve => { resetResolvers.push(resolve); });
        },
    };
    const ui = {
        init() { events.push('ui'); },
        setCallbacks(callbacks) { this.callbacks = callbacks; },
        startTimers() { events.push('timers'); },
        getWhiteTime() { return 900; },
        getBlackTime() { return 800; },
        updateTurnDisplay() {}, setEngineStatus() {}, setConnectionStatus() {}, setProviders() {},
        updateProviders() {}, setActiveEngine() {},
        setGameMode() {}, setArenaState() {},
        pauseTimers() { events.push('pauseTimers'); },
        stopTimers() { events.push('stopTimers'); },
        resumeTimers() { events.push('resumeTimers'); },
        showGameOverMessage(message) { events.push(message); },
        updateEngineInfo() {}, setGameOver() {}, showToast() {},
    };
    const board = {
        position(fen) { positions.push(fen); },
        orientation() {}, resize() {}, flip() {},
    };
    const context = {
        window: {
            Bridge: bridge,
            UI: ui,
            Settings: { load: () => ({ playerColor }) },
            MoveHistory: {
                init() { historyInitialized = true; historyMoves.length = 0; events.push('history'); },
                addMove(...args) {
                    assert.ok(historyInitialized, 'history must initialize before the first engine move');
                    historyMoves.push(args[1]);
                },
                undo() { historyMoves.pop(); },
                setResult(result) { events.push('result:' + result); },
            },
        },
        Chess: gameEndsAfter ? class extends OpeningChess {
            in_checkmate() { return this._history.length >= gameEndsAfter; }
        } : OpeningChess,
        Chessboard: (_element, config) => { boardConfig = config; return board; },
        $: selector => ({
            on() {},
            css(_property, value) { highlights.push({ selector, value }); },
        }),
        setTimeout: clock.setTimeout.bind(clock),
        clearTimeout: clock.clearTimeout.bind(clock),
        console: { log() {}, warn() {}, error() {} },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'game.js'), 'utf8'), context,
        { filename: 'game.js' });
    const game = context.window.Game;
    game.init();

    function completeSearch(index, move) { searches[index].options.onBestMove(move); }
    function engineReady() {
        bridge.ready = true;
        bridge.callbacks.onReady();
    }
    function finishNewGame(success = true, index = resetResolvers.length - 1) {
        if (success) engineReady();
        resetResolvers[index](success);
    }
    return {
        game, bridge, ui, searches, events, highlights, historyMoves, positions, clock,
        completeSearch, engineReady, finishNewGame, get boardConfig() { return boardConfig; },
    };
}

test('playing black starts one engine move after history and timers initialize', () => {
    const h = createHarness({ playerColor: 'black', immediateMove: 'e2e4' });
    assert.equal(h.searches.length, 1);
    assert.ok(h.events.indexOf('history') < h.events.indexOf('search'));
    assert.ok(h.events.indexOf('timers') < h.events.indexOf('search'));
    assert.deepEqual(h.historyMoves, ['e2e4']);
    assert.equal(h.game.getCurrentFEN(), E4);
    h.engineReady();
    assert.equal(h.searches.length, 1, 'repeated ready notifications cannot start another move');
});

test('playing black while the engine connects waits for readiness', () => {
    const h = createHarness({ playerColor: 'black', ready: false });
    assert.equal(h.searches.length, 0);
    assert.equal(h.game.makeMove('e2', 'e4'), false);
    h.engineReady();
    assert.equal(h.searches.length, 1);
    h.engineReady();
    assert.equal(h.searches.length, 1);
    h.completeSearch(0, 'e2e4');
    assert.equal(h.game.getCurrentFEN(), E4);
});

test('new black game starts one move after reset resolves and rejects the old move', async () => {
    const h = createHarness({ playerColor: 'black' });
    assert.equal(h.searches.length, 1);
    const reset = h.game.newGame();
    h.completeSearch(0, 'e2e4');
    assert.equal(h.game.getCurrentFEN(), START);
    assert.equal(h.searches.length, 1);
    h.finishNewGame();
    await reset;
    assert.equal(h.searches.length, 2, 'onReady and the reset promise produce a single search');
    h.completeSearch(1, 'e2e4');
    assert.equal(h.game.getCurrentFEN(), E4);
    assert.deepEqual(h.historyMoves, ['e2e4']);
});

test('hint highlights squares without playing a move and blocks input while pending', () => {
    const h = createHarness();
    h.game.hint();
    h.game.hint();
    assert.equal(h.searches.length, 1);
    assert.equal(h.game.makeMove('e2', 'e4'), false);
    assert.equal(h.boardConfig.onDragStart('e2', 'wP'), false);
    assert.equal(h.boardConfig.onDrop('e2', 'e4'), 'snapback');
    h.completeSearch(0, 'e2e4');
    assert.equal(h.game.getCurrentFEN(), START);
    assert.deepEqual(h.historyMoves, []);
    assert.deepEqual(h.highlights.map(highlight => highlight.selector), [
        '#chess-board .square-e2', '#chess-board .square-e4',
    ]);
    assert.equal(h.game.makeMove('e2', 'e4'), true);
    h.completeSearch(1, 'e7e5');
    assert.equal(h.game.getCurrentFEN(), E4_E5);
    assert.deepEqual(h.historyMoves, ['e2e4', 'e7e5']);
});

test('selecting history cancels an engine result even when the selected FEN matches', () => {
    const h = createHarness();
    h.game.makeMove('e2', 'e4');
    assert.equal(h.searches[0].fen, E4_ENGINE);
    h.game.setPositionFromHistory(E4);
    h.completeSearch(0, 'e7e5');
    assert.equal(h.game.getCurrentFEN(), E4);
    assert.deepEqual(h.historyMoves, ['e2e4']);
    assert.ok(h.events.includes('stop'));
});

test('a hint response from the previous game cannot highlight the new board', async () => {
    const h = createHarness();
    h.game.hint();
    const reset = h.game.newGame();
    h.finishNewGame();
    await reset;
    h.completeSearch(0, 'e2e4');
    assert.deepEqual(h.highlights, []);
    assert.equal(h.game.getCurrentFEN(), START);
    assert.equal(h.game.makeMove('e2', 'e4'), true);
});

test('remote move validation uses a copy of the searched position', () => {
    const h = createHarness();
    h.game.makeMove('e2', 'e4');
    const validate = h.searches[0].options.validateMove;
    assert.equal(validate('e7e5'), true);
    assert.equal(validate('e2e4'), false);
    assert.equal(validate('bad response'), false);
    assert.equal(h.game.getCurrentFEN(), E4);
    h.completeSearch(0, 'e7e5');
    assert.equal(h.game.getCurrentFEN(), E4_E5);
});

test('a lone engine opening cannot be undone into a game with no next search', () => {
    const h = createHarness({ playerColor: 'black', immediateMove: 'e2e4' });
    assert.equal(h.game.undo(), false);
    assert.equal(h.game.getCurrentFEN(), E4);
    assert.deepEqual(h.historyMoves, ['e2e4']);
});

test('an uncapturable en passant target is removed only from the engine request', () => {
    const h = createHarness();
    h.game.makeMove('e2', 'e4');
    assert.equal(h.searches[0].fen, E4_ENGINE);
    assert.equal(h.game.getCurrentFEN(), E4);
});

test('a legal en passant target remains in the remote FEN', () => {
    const h = createHarness({ playerColor: 'black' });
    h.game.setPositionFromHistory(EN_PASSANT);
    h.game.hint();
    assert.equal(h.searches.at(-1).fen, EN_PASSANT);
    assert.equal(h.game.getCurrentFEN(), EN_PASSANT);
});

test('a pinned pawn cannot retain an illegal en passant target', () => {
    const h = createHarness();
    h.game.setPositionFromHistory(PINNED_EN_PASSANT);
    h.game.hint();
    assert.equal(h.searches[0].fen, PINNED_EN_PASSANT.replace(' d6 ', ' - '));
    assert.equal(h.game.getCurrentFEN(), PINNED_EN_PASSANT);
});

test('failed engine reset does not start a black-game move before readiness', async () => {
    const h = createHarness({ playerColor: 'black' });
    const reset = h.game.newGame();
    h.finishNewGame(false);
    await reset;
    assert.equal(h.searches.length, 1);
    assert.equal(h.game.getCurrentFEN(), START);
    const retry = h.game.newGame();
    h.finishNewGame();
    await retry;
    assert.equal(h.searches.length, 2);
});

test('overlapping new games only start a move for the latest reset', async () => {
    const h = createHarness({ playerColor: 'black' });
    const oldReset = h.game.newGame();
    const currentReset = h.game.newGame();
    h.finishNewGame(true, 0);
    await oldReset;
    assert.equal(h.searches.length, 1);
    h.finishNewGame(true, 1);
    await currentReset;
    assert.equal(h.searches.length, 2);
});

async function startArena(h, { whiteEngine = 'old', blackEngine = 'new' } = {}) {
    const started = h.game.startGame({ mode: 'arena', whiteEngine, blackEngine });
    h.finishNewGame();
    await started;
    assert.equal(h.game.getGameMode(), 'arena');
}

test('human play uses the opponent selected in the new game controls', async () => {
    const h = createHarness();
    const started = h.game.startGame({ mode: 'human', opponentEngine: 'new' });
    h.finishNewGame();
    await started;
    assert.equal(h.bridge.getActiveEngine(), 'new');
    assert.equal(h.game.makeMove('e2', 'e4'), true);
    assert.equal(h.searches.length, 1);
    assert.equal(h.searches[0].options.engine, 'new');
    h.completeSearch(0, 'e7e5');
    assert.equal(h.game.getCurrentFEN(), E4_E5);
});

test('arena alternates the selected engines with a visible pause between moves', async () => {
    const h = createHarness();
    await startArena(h, { whiteEngine: 'new', blackEngine: 'old' });
    assert.equal(h.searches.length, 1);
    assert.equal(h.searches[0].options.engine, 'new');
    assert.equal(h.searches[0].options.allowFallback, false);
    h.completeSearch(0, 'e2e4');
    assert.equal(h.game.getCurrentFEN(), E4);
    assert.equal(h.searches.length, 1);
    h.clock.tick(299);
    assert.equal(h.searches.length, 1);
    h.clock.tick(1);
    assert.equal(h.searches.length, 2);
    assert.equal(h.searches[1].options.engine, 'old');
    assert.equal(h.searches[1].options.allowFallback, false);
    assert.equal(h.searches[1].fen, E4_ENGINE);
    h.completeSearch(1, 'e7e5');
    h.clock.tick(300);
    assert.equal(h.searches.length, 3);
    assert.equal(h.searches[2].options.engine, 'new');
    h.completeSearch(2, 'g1f3');
    assert.deepEqual(h.historyMoves, ['e2e4', 'e7e5', 'g1f3']);
});

test('arena prevents human moves, drags, hints and undo even between engine turns', async () => {
    const h = createHarness();
    await startArena(h);
    assert.equal(h.game.makeMove('e2', 'e4'), false);
    assert.equal(h.boardConfig.onDragStart('e2', 'wP'), false);
    assert.equal(h.boardConfig.onDrop('e2', 'e4'), 'snapback');
    h.completeSearch(0, 'e2e4');
    h.clock.tick(300);
    h.completeSearch(1, 'e7e5');
    const count = h.searches.length;
    h.game.hint();
    assert.equal(h.game.undo(), false);
    assert.equal(h.game.makeMove('g1', 'f3'), false);
    assert.equal(h.searches.length, count);
    assert.equal(h.game.getCurrentFEN(), E4_E5);
});

test('pausing an arena search rejects its late result and resumes the same position once', async () => {
    const h = createHarness();
    await startArena(h);
    h.game.toggleArenaPause();
    assert.equal(h.game.getArenaPaused(), true);
    assert.ok(h.events.includes('stop'));
    h.completeSearch(0, 'e2e4');
    assert.equal(h.game.getCurrentFEN(), START);
    h.clock.tick(1000);
    assert.equal(h.searches.length, 1);
    const resuming = h.game.toggleArenaPause();
    h.finishNewGame();
    await resuming;
    assert.equal(h.game.getArenaPaused(), false);
    assert.equal(h.searches.length, 2);
    assert.equal(h.searches[1].fen, START);
    assert.equal(h.events.filter(event => event === 'timers').length, 2,
        'resume preserves clocks instead of starting another game timer');
    h.engineReady();
    assert.equal(h.searches.length, 2);
    h.completeSearch(1, 'e2e4');
    assert.equal(h.game.getCurrentFEN(), E4);
});

test('pausing between arena moves cancels the queued next turn', async () => {
    const h = createHarness();
    await startArena(h);
    h.completeSearch(0, 'e2e4');
    h.game.toggleArenaPause();
    h.clock.tick(1000);
    assert.equal(h.searches.length, 1);
    const resuming = h.game.toggleArenaPause();
    h.finishNewGame();
    await resuming;
    assert.equal(h.searches.length, 2);
    assert.equal(h.searches[1].fen, E4_ENGINE);
    assert.equal(h.searches[1].options.engine, 'new');
});

test('losing an arena provider pauses the game and rejects a pending move', async () => {
    const h = createHarness();
    await startArena(h);
    Object.assign(h.bridge.providers.old, { connected: false, ready: false, state: 'unavailable' });
    h.bridge.callbacks.onProvidersChange(h.bridge.providers);
    assert.equal(h.game.getArenaPaused(), true);
    h.completeSearch(0, 'e2e4');
    h.clock.tick(1000);
    assert.equal(h.game.getCurrentFEN(), START);
    assert.equal(h.searches.length, 1);
    h.game.toggleArenaPause();
    assert.equal(h.game.getArenaPaused(), true, 'a missing engine cannot be silently substituted');
    assert.equal(h.searches.length, 1);
});

test('switching from arena to a human game cancels both late results and queued turns', async () => {
    const h = createHarness();
    await startArena(h);
    h.completeSearch(0, 'e2e4');
    const restarted = h.game.startGame({ mode: 'human', opponentEngine: 'new' });
    h.finishNewGame();
    await restarted;
    h.clock.tick(1000);
    h.completeSearch(0, 'e2e4');
    assert.equal(h.game.getGameMode(), 'human');
    assert.equal(h.game.getCurrentFEN(), START);
    assert.equal(h.searches.length, 1);
    assert.equal(h.game.makeMove('e2', 'e4'), true);
    assert.equal(h.searches.at(-1).options.engine, 'new');
});

test('checkmate ends arena play without scheduling another engine', async () => {
    const h = createHarness({ gameEndsAfter: 1 });
    await startArena(h);
    h.completeSearch(0, 'e2e4');
    assert.equal(h.game.isGameOver(), true);
    h.clock.tick(1000);
    h.engineReady();
    assert.equal(h.searches.length, 1);
});

test('time expiry ends arena play and ignores a late best move', async () => {
    const h = createHarness();
    await startArena(h);
    h.ui.callbacks.onTimeOut('white');
    assert.equal(h.game.isGameOver(), true);
    h.completeSearch(0, 'e2e4');
    h.clock.tick(1000);
    assert.equal(h.game.getCurrentFEN(), START);
    assert.equal(h.searches.length, 1);
});
