/* Adapter for the pinned upstream Engine API; source attribution is in wukong.js. */
(function () {
    'use strict';

    let engine = null;
    let currentRequest = null;
    const originalLog = console.log.bind(console);

    function parseInfo(line) {
        const tokens = line.trim().split(/\s+/);
        const info = { depth: 0, score: 0, mate: null, nodes: 0, nps: 0, time: 0, pv: [], perspective: 'sideToMove' };
        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i] === 'depth') info.depth = Number(tokens[++i]) || 0;
            else if (tokens[i] === 'score') {
                const type = tokens[++i];
                if (type === 'mate') info.mate = Number(tokens[++i]);
                else if (type === 'cp') info.score = Number(tokens[++i]) || 0;
            } else if (tokens[i] === 'nodes') info.nodes = Number(tokens[++i]) || 0;
            else if (tokens[i] === 'time') info.time = Number(tokens[++i]) || 0;
            else if (tokens[i] === 'pv') { info.pv = tokens.slice(i + 1); break; }
        }
        if (info.time > 0) info.nps = Math.round(info.nodes * 1000 / info.time);
        return info;
    }

    // The upstream API emits search information through console.log.
    // Convert it to structured messages without changing the upstream source.
    console.log = function () {
        const line = Array.prototype.join.call(arguments, ' ');
        if (currentRequest && line.startsWith('info ')) {
            self.postMessage({ type: 'info', id: currentRequest.id, fen: currentRequest.fen, info: parseInfo(line) });
        } else if (!currentRequest) originalLog.apply(console, arguments);
    };

    self.onmessage = function (event) {
        const message = event.data;
        if (!message || typeof message !== 'object') return;
        try {
            if (message.type === 'init') {
                if (!engine) {
                    importScripts('wukong.js');
                    engine = new Engine();
                    engine.setHashSize(16);
                    engine.setBoard(engine.START_FEN);
                    if (engine.generateLegalMoves().length !== 20) throw new Error('Engine initialization failed');
                }
                self.postMessage({ type: 'ready' });
            } else if (message.type === 'newgame' && engine) {
                engine.resetTimeControl();
                engine.setBoard(engine.START_FEN);
                self.postMessage({ type: 'ready' });
            } else if (message.type === 'search' && engine) {
                currentRequest = message;
                engine.setBoard(message.fen);
                engine.resetTimeControl();
                const started = Date.now();
                const milliseconds = Math.max(100, Math.min(2000, Number(message.movetime) || 500));
                engine.setTimeControl({ timeSet: 1, time: milliseconds, stopped: 0, startTime: started, stopTime: started + milliseconds });
                const legalMoves = engine.generateLegalMoves();
                if (!legalMoves.length) throw new Error('Нет допустимых ходов.');
                const bestMove = engine.search(64);
                const move = engine.moveToString(bestMove);
                if (!legalMoves.some(function (candidate) { return engine.moveToString(candidate.move) === move; })) {
                    throw new Error('Новый движок Марика вернул некорректный ход.');
                }
                self.postMessage({ type: 'bestmove', id: message.id, fen: message.fen, move: move });
                currentRequest = null;
            }
        } catch (error) {
            currentRequest = null;
            self.postMessage({ type: 'error', id: message.id, fen: message.fen, error: error && error.message ? error.message : 'Новый движок Марика недоступен.' });
        }
    };
})();
