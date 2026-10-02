(function () {
    'use strict';

    const legacy = window.LegacyBridge;
    const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
    const BOOT_TIMEOUT_MS = 5000;
    const providers = {
        old: { id: 'old', name: 'Старый движок Марика', connected: false, ready: false, state: 'connecting' },
        new: { id: 'new', name: 'Новый движок Марика', connected: false, ready: false, state: 'connecting' }
    };
    const state = {
        initialized: false,
        initializing: false,
        initialization: null,
        callbacks: {},
        activeEngine: 'old',
        position: { fen: START_FEN, moves: [] },
        active: null,
        requestId: 0,
        session: 0,
        worker: null,
        workerBootTimer: null,
        workerReadyPromise: null,
        resolveWorkerReady: null,
        localReady: false,
        lastInfo: null,
        lastBestMove: null,
        notifiedReady: false
    };

    function getProviders() {
        return { old: Object.assign({}, providers.old), new: Object.assign({}, providers.new) };
    }

    function notifyProviders() {
        if (state.callbacks.onProvidersChange) state.callbacks.onProvidersChange(getProviders());
        if (state.callbacks.onConnectionChange) {
            state.callbacks.onConnectionChange(providers.old.connected, getConnectionState());
        }
        const ready = providers.old.ready || providers.new.ready || state.localReady;
        if (ready && !state.initializing && !state.notifiedReady) {
            state.notifiedReady = true;
            if (state.callbacks.onReady) state.callbacks.onReady();
        } else if (!ready) state.notifiedReady = false;
    }

    function setProvider(id, connectionState) {
        const provider = providers[id];
        provider.state = connectionState;
        provider.ready = provider.connected = connectionState === 'ready';
        notifyProviders();
    }

    function ready(id) {
        if (id === 'local') return state.localReady || legacy.getLocalReady();
        return !!(providers[id] && providers[id].ready);
    }

    function getConnectionState() {
        if (providers.old.connected || providers.new.connected) return 'remote';
        if (providers.old.state === 'connecting' || providers.new.state === 'connecting') return 'connecting';
        return ready('local') ? 'local' : 'error';
    }

    function finishWorkerInitialization(success) {
        clearTimeout(state.workerBootTimer);
        state.workerBootTimer = null;
        const resolve = state.resolveWorkerReady;
        state.resolveWorkerReady = null;
        if (resolve) resolve(success);
    }

    function disposeNewWorker() {
        const worker = state.worker;
        state.worker = null;
        if (worker) {
            worker.onmessage = worker.onerror = worker.onmessageerror = null;
            worker.terminate();
        }
        finishWorkerInitialization(false);
        state.workerReadyPromise = null;
    }

    function failNewWorker(error) {
        const request = state.active && state.active.engine === 'new' ? state.active : null;
        disposeNewWorker();
        setProvider('new', 'unavailable');
        if (request) requestFailed(request, error || 'Новый движок Марика недоступен.');
    }

    function initializeNew() {
        if (ready('new') && state.worker) return Promise.resolve(true);
        if (state.workerReadyPromise) return state.workerReadyPromise;
        setProvider('new', 'connecting');
        state.workerReadyPromise = new Promise(function (resolve) { state.resolveWorkerReady = resolve; });
        const promise = state.workerReadyPromise;
        try {
            const worker = new Worker('engine/wukong-worker.js');
            state.worker = worker;
            state.workerBootTimer = setTimeout(function () {
                if (state.worker === worker) failNewWorker('Новый движок Марика не ответил при запуске.');
            }, BOOT_TIMEOUT_MS);
            worker.onmessage = function (event) {
                if (state.worker !== worker) return;
                const message = event.data;
                if (!message || typeof message !== 'object') return;
                if (message.type === 'ready') {
                    setProvider('new', 'ready');
                    finishWorkerInitialization(true);
                    return;
                }
                const request = state.active;
                if (message.type === 'error' && !message.id && state.resolveWorkerReady) {
                    failNewWorker(message.error);
                    return;
                }
                if (!request || request.engine !== 'new' || message.id !== request.id || message.fen !== request.finalFen) return;
                if (message.type === 'info') publishInfo(request, message.info);
                else if (message.type === 'bestmove') {
                    if (validMove(request, message.move)) completeSearch(request, message.move, null);
                    else failNewWorker('Новый движок Марика вернул некорректный ход.');
                } else if (message.type === 'error') failNewWorker(message.error);
            };
            worker.onerror = worker.onmessageerror = function (error) {
                if (state.worker === worker) failNewWorker(error && error.message);
            };
            worker.postMessage({ type: 'init' });
        } catch (error) { failNewWorker(error && error.message); }
        return promise;
    }

    function ensureLocal() {
        return legacy.ensureFallback().then(function (success) {
            state.localReady = !!success;
            notifyProviders();
            return success;
        });
    }

    legacy.setCallbacks({
        onConnectionChange: function (connected, connectionState) {
            setProvider('old', connected ? 'ready' : (connectionState === 'connecting' ? 'connecting' : 'unavailable'));
        },
        onLocalReady: function (success) {
            state.localReady = success;
            notifyProviders();
        },
        onError: function (error) {
            const request = state.active;
            if (request && (request.engine === 'old' || request.engine === 'local')) requestFailed(request, error);
        }
    });

    function initialize(reset) {
        stopSearch();
        state.initialized = true;
        state.initializing = true;
        const session = ++state.session;
        state.lastInfo = state.lastBestMove = null;
        if (reset && state.worker && ready('new')) {
            try { state.worker.postMessage({ type: 'newgame' }); }
            catch (error) { failNewWorker(error && error.message); }
        }
        const oldPromise = reset ? legacy.newGame({ remoteOnly: true }) : legacy.init({ remoteOnly: true });
        const newPromise = initializeNew();
        state.initialization = Promise.all([oldPromise, newPromise]).then(function () {
            if (session !== state.session) return false;
            if (providers.old.ready || providers.new.ready) {
                if (!ready(state.activeEngine)) state.activeEngine = providers.old.ready ? 'old' : 'new';
                state.initializing = false;
                notifyProviders();
                return true;
            }
            return ensureLocal().then(function (success) {
                if (session !== state.session) return false;
                if (success) state.activeEngine = 'local';
                state.initializing = false;
                notifyProviders();
                if (!success && state.callbacks.onError) state.callbacks.onError('Не удалось запустить движки Марика.');
                return success;
            });
        });
        return state.initialization;
    }

    function init() {
        if (state.initialized) return state.initialization || Promise.resolve(ready(state.activeEngine));
        return initialize(false);
    }

    function newGame() { return initialize(true); }

    function finalFen(fen, moves) {
        if (!moves.length) return fen;
        if (typeof Chess !== 'function') throw new Error('Не удалось загрузить позицию.');
        const position = new Chess(fen);
        for (const move of moves) {
            if (!position.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] })) {
                throw new Error('Некорректная последовательность ходов.');
            }
        }
        return position.fen();
    }

    function validMove(request, move) {
        if (typeof move !== 'string' || !UCI_MOVE.test(move)) return false;
        try {
            if (request.options.validateMove) return !!request.options.validateMove(move);
            if (typeof Chess !== 'function') return true;
            const position = new Chess(request.finalFen);
            return !!position.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
        } catch (error) { return false; }
    }

    function publishInfo(request, info) {
        if (state.active !== request || !info || typeof info !== 'object') return;
        state.lastInfo = Object.assign({}, info, { engine: request.engine });
        const callback = request.options.onInfo || state.callbacks.onInfo;
        if (callback) callback(state.lastInfo);
    }

    function completeSearch(request, move, ponder) {
        if (state.active !== request) return;
        clearTimeout(request.timer);
        state.active = null;
        state.lastBestMove = move;
        const callback = request.options.onBestMove || state.callbacks.onBestMove;
        if (callback) callback(move, ponder);
    }

    function reportError(request, error) {
        if (state.active !== request) return;
        clearTimeout(request.timer);
        state.active = null;
        const callback = request.options.onError || state.callbacks.onError;
        if (callback) callback(typeof error === 'string' ? error : 'Выбранный движок Марика недоступен.');
    }

    function requestFailed(request, error) {
        if (state.active !== request) return;
        clearTimeout(request.timer);
        request.timer = null;
        if (request.options.allowFallback === false) { reportError(request, error); return; }
        const alternate = request.engine === 'old' ? 'new' : 'old';
        if (!request.attempted.has(alternate) && ready(alternate)) { routeSearch(request, alternate); return; }
        if (!request.attempted.has('local')) {
            ensureLocal().then(function (success) {
                if (state.active !== request) return;
                if (success) routeSearch(request, 'local');
                else reportError(request, error);
            });
        } else reportError(request, error);
    }

    function routeSearch(request, id) {
        if (state.active !== request) return;
        if (id === 'local' && !ready(id) && !request.attempted.has(id)) {
            request.engine = id;
            request.attempted.add(id);
            ensureLocal().then(function (success) {
                if (state.active !== request) return;
                if (success) routeSearch(request, id);
                else requestFailed(request, 'Резервный движок недоступен.');
            });
            return;
        }
        if (!ready(id)) { request.engine = id; request.attempted.add(id); requestFailed(request, 'Выбранный движок Марика недоступен.'); return; }
        const previous = request.engine;
        request.engine = id;
        request.attempted.add(id);
        if (previous !== id) {
            state.activeEngine = id;
            const callback = request.options.onProviderFallback || state.callbacks.onProviderFallback;
            if (callback) callback(previous, id);
        }
        if (id === 'new') {
            const milliseconds = Math.max(100, Math.min(2000, Number(request.options.movetime) || 500));
            const worker = state.worker;
            request.timer = setTimeout(function () {
                if (state.active === request && state.worker === worker) failNewWorker('Новый движок Марика не ответил вовремя.');
            }, milliseconds + 2000);
            try { worker.postMessage({ type: 'search', id: request.id, fen: request.finalFen, movetime: milliseconds }); }
            catch (error) { failNewWorker(error && error.message); }
        } else {
            legacy.setPosition(request.fen, request.moves);
            const options = Object.assign({}, request.options, {
                local: id === 'local',
                allowFallback: false,
                onBestMove: function (move, ponder) {
                    if (state.active !== request) return;
                    if (validMove(request, move)) completeSearch(request, move, ponder);
                    else requestFailed(request, 'Движок Марика вернул некорректный ход.');
                },
                onInfo: function (info) { publishInfo(request, info); },
                onError: function (error) { requestFailed(request, error); }
            });
            if (!legacy.startSearch(options)) requestFailed(request, 'Движок Марика занят.');
        }
    }

    function startSearch(options) {
        if (state.active) return false;
        options = options || {};
        const id = options.engine || state.activeEngine;
        if (id !== 'old' && id !== 'new' && id !== 'local') return false;
        const request = {
            id: ++state.requestId,
            engine: id,
            options: Object.assign({}, options),
            fen: state.position.fen,
            moves: state.position.moves.slice(),
            finalFen: null,
            timer: null,
            attempted: new Set()
        };
        state.active = request;
        try { request.finalFen = finalFen(request.fen, request.moves); }
        catch (error) { reportError(request, error.message); return true; }
        if (!state.initialized) {
            // Initialization cancels existing work, so start it before retaining this request.
            state.active = null;
            const pending = init();
            state.active = request;
            pending.then(function (success) {
                if (state.active !== request) return;
                if (success) routeSearch(request, id);
                else reportError(request, 'Не удалось запустить движки Марика.');
            });
        } else if (state.initializing) {
            Promise.resolve(state.initialization).then(function (success) {
                if (state.active !== request) return;
                if (success) routeSearch(request, id);
                else reportError(request, 'Не удалось запустить движки Марика.');
            });
        } else routeSearch(request, id);
        return true;
    }

    function stopSearch() {
        const request = state.active;
        state.active = null;
        if (!request) return;
        clearTimeout(request.timer);
        if (request.engine === 'new') {
            // Synchronous API searches cannot process a stop message. Termination
            // prevents cancelled results and frees the browser thread immediately.
            disposeNewWorker();
            setProvider('new', 'connecting');
            initializeNew();
        } else {
            legacy.stopSearch();
            if (request.engine === 'old') legacy.ensureRemote();
        }
    }

    function setActiveEngine(id) {
        if (id !== 'old' && id !== 'new' && id !== 'local') return false;
        state.activeEngine = id;
        return true;
    }

    function quit() {
        const request = state.active;
        state.active = null;
        if (request) clearTimeout(request.timer);
        ++state.session;
        disposeNewWorker();
        legacy.quit();
        state.initialized = false;
        state.initializing = false;
        state.initialization = null;
        state.localReady = false;
        setProvider('old', 'unavailable');
        setProvider('new', 'unavailable');
    }

    window.Bridge = {
        init: init,
        newGame: newGame,
        getProviders: getProviders,
        getEngineReady: function (id) { return ready(id || state.activeEngine); },
        getActiveEngine: function () { return state.activeEngine; },
        setActiveEngine: setActiveEngine,
        setPosition: function (fen, moves) { state.position = { fen: fen, moves: moves ? moves.slice() : [] }; },
        startSearch: startSearch,
        stopSearch: stopSearch,
        isSearching: function () { return !!state.active; },
        setCallbacks: function (callbacks) { state.callbacks = Object.assign({}, state.callbacks, callbacks); },
        getInfo: function () { return state.lastInfo; },
        getLastBestMove: function () { return state.lastBestMove; },
        getRemoteConnected: function () { return providers.old.connected || providers.new.connected; },
        getConnectionState: getConnectionState,
        setOption: legacy.setOption,
        sendCommand: legacy.sendCommand,
        quit: quit
    };
})();
