(function () {
    'use strict';

    const REMOTE_URL = 'wss://chess-api.com/v1';
    const CONNECT_TIMEOUT_MS = 2500;
    const SEARCH_TIMEOUT_MS = 1800;
    const STOP_TIMEOUT_MS = 1500;
    const LOCAL_BOOT_TIMEOUT_MS = 45000;
    const STOCKFISH_WASM_URL = 'https://storage.yandexcloud.net/demony/stockfish.wasm';
    const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

    const state = {
        worker: null,
        socket: null,
        callbacks: {},
        initialized: false,
        remoteOnly: false,
        ready: false,
        connection: 'local',
        localReady: false,
        localUciInitialized: false,
        localResetPending: false,
        localAwaitingReady: false,
        localActive: null,
        localDraining: false,
        active: null,
        position: { fen: START_FEN, moves: [] },
        lastBestMove: null,
        lastInfo: null,
        connectTimer: null,
        bootTimer: null,
        drainTimer: null,
        readyPromise: null,
        resolveReady: null,
        localReadyPromise: null,
        resolveLocalReady: null,
        session: 0,
        requestId: 0,
        completedRemoteTasks: new Set(),
        options: new Map()
    };

    function setConnection(connection) {
        if (state.connection === connection) return;
        state.connection = connection;
        if (state.callbacks.onConnectionChange) {
            state.callbacks.onConnectionChange(connection === 'remote', connection);
        }
    }

    function setReady(ready) {
        const becameReady = ready && !state.ready;
        state.ready = ready;
        if (becameReady && state.callbacks.onReady) state.callbacks.onReady();
    }

    function finishReadyCheck(ready) {
        if (!state.resolveReady) return;
        const resolve = state.resolveReady;
        state.resolveReady = null;
        resolve(ready);
    }

    function beginReadyCheck() {
        finishReadyCheck(false);
        state.readyPromise = new Promise(function (resolve) { state.resolveReady = resolve; });
        setReady(false);
        return state.readyPromise;
    }

    function closeSocket() {
        clearTimeout(state.connectTimer);
        state.connectTimer = null;
        const socket = state.socket;
        state.socket = null;
        state.completedRemoteTasks.clear();
        if (!socket) return;
        socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
        try { socket.close(); } catch (error) { /* Already closed. */ }
    }

    function connectRemote() {
        closeSocket();
        setReady(false);
        setConnection('connecting');
        let socket;
        try {
            socket = new WebSocket(REMOTE_URL);
        } catch (error) {
            useLocal();
            return;
        }
        state.socket = socket;
        state.connectTimer = setTimeout(function () {
            if (state.socket === socket) useLocal();
        }, CONNECT_TIMEOUT_MS);
        socket.onopen = function () {
            if (state.socket !== socket) return;
            clearTimeout(state.connectTimer);
            state.connectTimer = null;
            setConnection('remote');
            setReady(true);
            finishReadyCheck(true);
            pumpSearch();
        };
        socket.onmessage = function (event) { handleRemoteMessage(socket, event); };
        socket.onerror = socket.onclose = function () {
            if (state.socket === socket) useLocal();
        };
    }

    function useLocal() {
        let failedRequest = null;
        if (state.active && state.active.source === 'remote') {
            clearTimeout(state.active.timer);
            state.active.timer = null;
            if (state.active.options.allowFallback === false) {
                failedRequest = state.active;
                state.active = null;
            } else {
                state.active.source = 'pending';
                state.active.candidate = null;
            }
        }
        closeSocket();
        setReady(false);
        setConnection('local');
        if (state.remoteOnly) {
            finishReadyCheck(false);
            if (failedRequest && failedRequest.onError) failedRequest.onError('Старый движок Марика недоступен.');
            return;
        }
        ensureLocalWorker();
        if (state.localReady) {
            setReady(true);
            finishReadyCheck(true);
            pumpSearch();
        }
        if (failedRequest && failedRequest.onError) failedRequest.onError('Старый движок Марика недоступен.');
    }

    function workerCommand(command) {
        if (!state.worker) return;
        try {
            state.worker.postMessage(command);
        } catch (error) {
            failLocal(error);
        }
    }

    function disposeWorker() {
        clearTimeout(state.bootTimer);
        clearTimeout(state.drainTimer);
        state.bootTimer = state.drainTimer = null;
        const worker = state.worker;
        state.worker = null;
        state.localReady = state.localUciInitialized = state.localAwaitingReady = false;
        state.localReadyPromise = null;
        state.localActive = null;
        state.localDraining = false;
        if (state.callbacks.onLocalReady) state.callbacks.onLocalReady(false);
        if (worker) {
            worker.onmessage = worker.onerror = worker.onmessageerror = null;
            worker.terminate();
        }
    }

    function failLocal(error) {
        const request = state.active;
        const selected = state.connection === 'local' || (request && request.options.local);
        disposeWorker();
        if (state.resolveLocalReady) {
            state.resolveLocalReady(false);
            state.resolveLocalReady = null;
            state.localReadyPromise = null;
        }
        if (state.callbacks.onLocalReady) state.callbacks.onLocalReady(false);
        if (!selected) return;
        if (state.active) clearTimeout(state.active.timer);
        state.active = null;
        setReady(false);
        if (state.connection !== 'remote') setConnection('error');
        finishReadyCheck(false);
        if (request && request.onError) {
            request.onError(error && error.message ? error.message : 'Не удалось запустить локальный движок.');
        } else if (state.callbacks.onError) {
            state.callbacks.onError(error && error.message ? error.message : 'Не удалось запустить локальный движок.');
        }
    }

    function ensureLocalWorker() {
        if (state.worker) return;
        try {
            const worker = new Worker('engine/stockfish.js#' + encodeURIComponent(STOCKFISH_WASM_URL));
            state.worker = worker;
            state.bootTimer = setTimeout(function () {
                if (state.worker === worker) failLocal(new Error('Локальный движок не ответил при запуске.'));
            }, LOCAL_BOOT_TIMEOUT_MS);
            worker.onmessage = function (event) {
                if (state.worker !== worker || typeof event.data !== 'string') return;
                event.data.split(/\r?\n/).forEach(parseUCIOutput);
            };
            worker.onerror = worker.onmessageerror = function (error) {
                if (state.worker === worker) failLocal(error);
            };
            workerCommand('uci');
        } catch (error) {
            failLocal(error);
        }
    }

    function requestLocalReady() {
        if (!state.worker || !state.localUciInitialized || state.localActive) return;
        const worker = state.worker;
        clearTimeout(state.bootTimer);
        state.bootTimer = setTimeout(function () {
            if (state.worker === worker) failLocal(new Error('Локальный движок не ответил при запуске.'));
        }, LOCAL_BOOT_TIMEOUT_MS);
        if (state.localResetPending) {
            state.localResetPending = false;
            workerCommand('ucinewgame');
        }
        state.localAwaitingReady = true;
        workerCommand('isready');
    }

    function parseUCIOutput(line) {
        line = line.trim();
        if (line === 'uciok') {
            state.localUciInitialized = true;
            workerCommand('setoption name Skill Level value 20');
            workerCommand('setoption name Threads value 1');
            workerCommand('setoption name Hash value 32');
            workerCommand('setoption name Ponder value false');
            state.options.forEach(function (value, name) {
                workerCommand('setoption name ' + name + ' value ' + value);
            });
            requestLocalReady();
        } else if (line === 'readyok' && state.localAwaitingReady) {
            state.localAwaitingReady = false;
            state.localReady = true;
            clearTimeout(state.bootTimer);
            state.bootTimer = null;
            if (state.resolveLocalReady) {
                state.resolveLocalReady(true);
                state.resolveLocalReady = null;
            }
            if (state.callbacks.onLocalReady) state.callbacks.onLocalReady(true);
            if (state.connection === 'local') {
                setReady(true);
                finishReadyCheck(true);
                pumpSearch();
            }
            else pumpSearch();
        } else if (line.startsWith('bestmove ')) {
            handleLocalBestMove(line);
        } else if (line.startsWith('info ') && line.includes('depth')) {
            const request = state.localActive;
            if (request && request === state.active && !state.localDraining) {
                publishInfo(request, parseLocalInfo(line));
            }
        }
    }

    function parseLocalInfo(line) {
        const info = { depth: 0, score: 0, mate: null, nodes: 0, nps: 0, time: 0, pv: [], perspective: 'sideToMove' };
        const tokens = line.split(/\s+/);
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            if (token === 'depth') info.depth = parseInt(tokens[++i], 10);
            else if (token === 'score') {
                const type = tokens[++i];
                if (type === 'cp') info.score = parseInt(tokens[++i], 10);
                else if (type === 'mate') info.mate = parseInt(tokens[++i], 10);
            } else if (token === 'nodes') info.nodes = parseInt(tokens[++i], 10);
            else if (token === 'nps') info.nps = parseInt(tokens[++i], 10);
            else if (token === 'time') info.time = parseInt(tokens[++i], 10);
            else if (token === 'pv') {
                info.pv = tokens.slice(i + 1);
                break;
            }
        }
        return info;
    }

    function publishInfo(request, info) {
        if (state.active !== request) return;
        state.lastInfo = info;
        if (request.onInfo) request.onInfo(info);
    }

    function validMove(request, move) {
        if (typeof move !== 'string' || !UCI_MOVE.test(move)) return false;
        try {
            if (request.validateMove) return !!request.validateMove(move);
            if (typeof Chess === 'function') {
                const position = new Chess(request.remoteFen || request.fen);
                if (!request.remoteFen) {
                    for (const playedMove of request.moves) {
                        if (!position.move({
                            from: playedMove.slice(0, 2),
                            to: playedMove.slice(2, 4),
                            promotion: playedMove[4]
                        })) return false;
                    }
                }
                return !!position.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
            }
            return true;
        } catch (error) {
            return false;
        }
    }

    function remoteInfo(message, move) {
        const centipawns = message.centipawns === null || message.centipawns === undefined ? NaN : Number(message.centipawns);
        const evaluation = message.eval === null || message.eval === undefined ? NaN : Number(message.eval);
        const continuation = Array.isArray(message.continuationArr) ? message.continuationArr.filter(function (item) {
            return typeof item === 'string' && UCI_MOVE.test(item);
        }) : [];
        if (continuation[0] !== move) continuation.unshift(move);
        return {
            depth: Number(message.depth) || 0,
            score: Number.isFinite(centipawns) ? centipawns : (Number.isFinite(evaluation) ? Math.round(evaluation * 100) : 0),
            mate: message.mate === null || message.mate === undefined || !Number.isFinite(Number(message.mate)) ? null : Number(message.mate),
            nodes: Number(message.nodes) || 0,
            nps: Number(message.nps) || 0,
            time: Number(message.time) || 0,
            pv: continuation,
            perspective: 'white'
        };
    }

    function handleRemoteMessage(socket, event) {
        const request = state.active;
        if (state.socket !== socket || state.connection !== 'remote' || !request || request.source !== 'remote') return;
        let message;
        try { message = JSON.parse(event.data); } catch (error) { useLocal(); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { useLocal(); return; }
        if (message.fen !== undefined && message.fen !== request.remoteFen) return;
        if (state.completedRemoteTasks.has(message.taskId)) return;
        if (request.serverTaskId && message.taskId !== undefined && message.taskId !== request.serverTaskId) return;
        if (message.error || message.type === 'error') { useLocal(); return; }
        if (request.serverTaskId && message.taskId !== request.serverTaskId) return;
        if (message.type === 'info') return;
        // The service currently assigns its own taskId despite a supplied client id.
        // Bind it only when the response echoes this exact position, then keep it fixed.
        if (!request.serverTaskId) {
            if (typeof message.taskId !== 'string' || !message.taskId ||
                (message.fen !== request.remoteFen && message.taskId !== request.taskId)) return;
            request.serverTaskId = message.taskId;
        }
        if ((message.type !== 'move' && message.type !== 'bestmove') || !validMove(request, message.move)) {
            useLocal();
            return;
        }
        const info = remoteInfo(message, message.move);
        if (!request.candidate || info.depth >= request.candidate.depth || message.type === 'bestmove') {
            request.candidate = { move: message.move, depth: info.depth, info: info };
            publishInfo(request, info);
        }
        if (message.type === 'bestmove') completeSearch(request, message.move, null);
    }

    function completeSearch(request, move, ponder) {
        if (state.active !== request) return;
        clearTimeout(request.timer);
        if (request.source === 'remote' && request.serverTaskId) state.completedRemoteTasks.add(request.serverTaskId);
        state.active = null;
        state.lastBestMove = move;
        if (request.onBestMove) request.onBestMove(move, ponder);
    }

    function startRemoteSearch(request) {
        request.source = 'remote';
        request.taskId = 'burchess-' + state.session + '-' + (++state.requestId);
        request.remoteFen = request.fen;
        if (request.moves.length) {
            try {
                if (typeof Chess !== 'function') throw new Error('Cannot apply moves');
                const position = new Chess(request.fen);
                request.moves.forEach(function (move) {
                    if (!position.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] })) {
                        throw new Error('Illegal position move');
                    }
                });
                request.remoteFen = position.fen();
            } catch (error) { useLocal(); return; }
        }
        request.timer = setTimeout(function () {
            if (state.active !== request) return;
            if (state.socket && state.socket.readyState === 1 && request.candidate && validMove(request, request.candidate.move)) {
                completeSearch(request, request.candidate.move, null);
            } else {
                useLocal();
            }
        }, SEARCH_TIMEOUT_MS);
        try {
            state.socket.send(JSON.stringify({
                fen: request.remoteFen,
                variants: 1,
                depth: 18,
                maxThinkingTime: 100,
                taskId: request.taskId
            }));
        } catch (error) { useLocal(); }
    }

    function localGoCommand(options) {
        let command = 'go';
        if (options.wtime !== undefined && options.btime !== undefined) {
            command += ' wtime ' + options.wtime + ' btime ' + options.btime;
            if (options.winc) command += ' winc ' + options.winc;
            if (options.binc) command += ' binc ' + options.binc;
        } else if (options.depth) command += ' depth ' + options.depth;
        else if (options.movetime) command += ' movetime ' + options.movetime;
        else command += ' movetime 2000';
        return command;
    }

    function pumpSearch() {
        const request = state.active;
        if (!request || request.source !== 'pending') return;
        if (request.options.local) {
            if (!state.localReady || state.localActive || state.localDraining) return;
        } else if (!state.ready) return;
        if (!request.options.local && state.connection === 'remote') {
            if (state.socket && state.socket.readyState === 1) startRemoteSearch(request);
            else useLocal();
        } else if ((request.options.local || state.connection === 'local') && state.localReady && !state.localActive && !state.localDraining) {
            request.source = 'local';
            state.localActive = request;
            let command = 'position fen ' + request.fen;
            if (request.moves.length) command += ' moves ' + request.moves.join(' ');
            workerCommand(command);
            if (state.active === request && state.worker) workerCommand(localGoCommand(request.options));
        }
    }

    function afterLocalStop() {
        clearTimeout(state.drainTimer);
        state.drainTimer = null;
        state.localActive = null;
        state.localDraining = false;
        if (state.localResetPending) requestLocalReady();
        else pumpSearch();
    }

    function handleLocalBestMove(line) {
        const request = state.localActive;
        if (!request) return;
        if (state.localDraining || state.active !== request) { afterLocalStop(); return; }
        const parts = line.split(/\s+/);
        const move = parts[1];
        const ponder = parts[2] === 'ponder' ? parts[3] : null;
        state.localActive = null;
        if (!validMove(request, move)) {
            failLocal(new Error('Локальный движок вернул некорректный ход.'));
            return;
        }
        completeSearch(request, move, ponder);
    }

    function init(options) {
        if (state.initialized) return state.readyPromise || Promise.resolve(state.ready);
        state.remoteOnly = !!(options && options.remoteOnly);
        state.initialized = true;
        state.session++;
        const promise = beginReadyCheck();
        connectRemote();
        return promise;
    }

    function newGame(options) {
        stopSearch();
        if (options && options.remoteOnly !== undefined) state.remoteOnly = !!options.remoteOnly;
        state.initialized = true;
        state.session++;
        state.lastBestMove = state.lastInfo = null;
        const promise = beginReadyCheck();
        const reuseRemote = state.socket && state.connection === 'remote' && state.socket.readyState === 1;
        if (!reuseRemote) setConnection('connecting');
        if (state.worker) {
            state.localReady = false;
            if (!state.resolveLocalReady) state.localReadyPromise = null;
            if (state.callbacks.onLocalReady) state.callbacks.onLocalReady(false);
            state.localResetPending = true;
            requestLocalReady();
        }
        if (reuseRemote) {
            setReady(true);
            finishReadyCheck(true);
        } else connectRemote();
        return promise;
    }

    function setPosition(fen, moves) {
        state.position = { fen: fen, moves: moves ? moves.slice() : [] };
    }

    function startSearch(options) {
        if (state.active) return false;
        options = options || {};
        state.active = {
            fen: state.position.fen,
            moves: state.position.moves.slice(),
            options: Object.assign({}, options),
            source: 'pending',
            timer: null,
            candidate: null,
            serverTaskId: null,
            onBestMove: typeof options.onBestMove === 'function' ? options.onBestMove : state.callbacks.onBestMove,
            onInfo: typeof options.onInfo === 'function' ? options.onInfo : state.callbacks.onInfo,
            validateMove: typeof options.validateMove === 'function' ? options.validateMove : null,
            onError: typeof options.onError === 'function' ? options.onError : null
        };
        if (options.local) ensureFallback();
        else if (!state.initialized) init();
        else if (state.connection === 'error') useLocal();
        else if (state.connection === 'connecting' && !state.socket) connectRemote();
        pumpSearch();
        return true;
    }

    function stopSearch() {
        const request = state.active;
        if (!request) return;
        clearTimeout(request.timer);
        state.active = null;
        if (request.source === 'remote') {
            // A cancelled calculation can still stream results. A fresh connection
            // makes repeated positions and hints safe even when taskId is server-generated.
            closeSocket();
            setReady(false);
            setConnection('connecting');
        } else if (request.source === 'local' && state.localActive === request) {
            state.localDraining = true;
            state.drainTimer = setTimeout(function () {
                if (!state.localDraining) return;
                disposeWorker();
                state.localResetPending = true;
                if (state.connection === 'local') {
                    setReady(false);
                    ensureLocalWorker();
                }
            }, STOP_TIMEOUT_MS);
            workerCommand('stop');
        }
    }

    function setOption(name, value) {
        state.options.set(name, value);
        if (state.localUciInitialized) workerCommand('setoption name ' + name + ' value ' + value);
    }

    function quit() {
        stopSearch();
        finishReadyCheck(false);
        closeSocket();
        disposeWorker();
        if (state.resolveLocalReady) state.resolveLocalReady(false);
        state.resolveLocalReady = state.localReadyPromise = null;
        state.initialized = false;
        state.readyPromise = null;
        setReady(false);
        setConnection('local');
    }

    function setCallbacks(callbacks) {
        state.callbacks = Object.assign({}, state.callbacks, callbacks);
    }

    function ensureFallback() {
        if (state.localReady) return Promise.resolve(true);
        if (state.localReadyPromise) return state.localReadyPromise;
        state.localReadyPromise = new Promise(function (resolve) { state.resolveLocalReady = resolve; });
        const promise = state.localReadyPromise;
        ensureLocalWorker();
        return promise;
    }

    function ensureRemote() {
        if (state.socket && state.socket.readyState === 1) return Promise.resolve(true);
        if (state.socket && state.connection === 'connecting') return state.readyPromise;
        const promise = beginReadyCheck();
        connectRemote();
        return promise;
    }

    window.LegacyBridge = window.Bridge = {
        init: init,
        newGame: newGame,
        setPosition: setPosition,
        startSearch: startSearch,
        stopSearch: stopSearch,
        setOption: setOption,
        quit: quit,
        setCallbacks: setCallbacks,
        ensureFallback: ensureFallback,
        ensureRemote: ensureRemote,
        getLocalReady: function () { return state.localReady; },
        getInfo: function () { return state.lastInfo; },
        isSearching: function () { return !!state.active; },
        getLastBestMove: function () { return state.lastBestMove; },
        sendCommand: workerCommand,
        getEngineReady: function () { return state.ready; },
        getRemoteConnected: function () { return state.connection === 'remote' && !!state.socket && state.socket.readyState === 1; },
        getConnectionState: function () { return state.connection; }
    };
})();
