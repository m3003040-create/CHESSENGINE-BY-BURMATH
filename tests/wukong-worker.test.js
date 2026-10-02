const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { Chess } = require('../engine/examples/js/chess.min.js');

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function createWorker() {
    const messages = [];
    let nextId = 1;
    const context = vm.createContext({
        self: { postMessage: message => messages.push(message) },
        console: { log() {}, warn() {}, error() {} },
        Date,
    });
    context.importScripts = file => {
        assert.equal(file, 'wukong.js', 'the adapter loads the pinned engine bundled with the app');
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'engine', file), 'utf8'), context,
            { filename: file });
    };
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'engine', 'wukong-worker.js'), 'utf8'),
        context, { filename: 'wukong-worker.js' });
    function send(message) { context.self.onmessage({ data: message }); }
    send({ type: 'init' });
    assert.equal(messages.at(-1).type, 'ready');

    function search(fen, movetime = 100) {
        const id = nextId++;
        const start = messages.length;
        send({ type: 'search', id, fen, movetime });
        return { id, messages: messages.slice(start) };
    }
    return { messages, send, search };
}

function assertLegalResult(result, fen) {
    const errors = result.messages.filter(message => message.type === 'error');
    assert.equal(errors.length, 0, errors[0]?.error);
    const moves = result.messages.filter(message => message.type === 'bestmove');
    assert.equal(moves.length, 1, 'a calculation emits exactly one final move');
    const response = moves[0];
    assert.equal(response.id, result.id);
    assert.equal(response.fen, fen);
    const position = new Chess(fen);
    const legalMove = position.move({
        from: response.move.substring(0, 2),
        to: response.move.substring(2, 4),
        promotion: response.move[4],
    });
    assert.ok(legalMove, response.move + ' must be legal under the app chess rules');
    return legalMove;
}

test('the real new engine API starts and returns a legal time-limited opening move', () => {
    const worker = createWorker();
    const result = worker.search(START);
    assertLegalResult(result, START);
    const infos = result.messages.filter(message => message.type === 'info');
    assert.ok(infos.length > 0, 'upstream search progress reaches the application');
    for (const message of infos) {
        assert.equal(message.id, result.id);
        assert.equal(message.fen, START);
        assert.ok(message.info.depth > 0);
        assert.ok(Number.isFinite(message.info.score));
        assert.ok(message.info.nodes > 0);
    }
});

test('the new engine adapter preserves promotion notation in its final move', () => {
    const fen = '8/P7/k7/8/8/8/8/7K w - - 0 1';
    const move = assertLegalResult(createWorker().search(fen), fen);
    assert.equal(move.piece, 'p');
    assert.ok(['q', 'r', 'b', 'n'].includes(move.promotion));
});

test('the new engine accepts castling rights in the searched FEN', () => {
    const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
    assertLegalResult(createWorker().search(fen), fen);
});

test('the new engine handles a legal en passant capture', () => {
    const fen = '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1';
    const move = assertLegalResult(createWorker().search(fen), fen);
    assert.equal(move.flags.includes('e'), true);
    assert.equal(move.from + move.to, 'e5d6');
});

test('a new game resets the worker and subsequent moves belong to the new position', () => {
    const worker = createWorker();
    const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    assertLegalResult(worker.search(afterE4), afterE4);
    worker.send({ type: 'newgame' });
    assert.equal(worker.messages.at(-1).type, 'ready');
    assertLegalResult(worker.search(START), START);
});

test('terminal positions report a request-scoped failure without fabricating a move', () => {
    const fen = '7k/6Q1/5K2/8/8/8/8/8 b - - 0 1';
    const result = createWorker().search(fen);
    assert.equal(result.messages.filter(message => message.type === 'bestmove').length, 0);
    const errors = result.messages.filter(message => message.type === 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].id, result.id);
    assert.equal(errors[0].fen, fen);
});
