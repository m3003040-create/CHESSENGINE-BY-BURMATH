(function(){
    'use strict';

    // ======================== Состояние игры ========================
    let chess = null;           // chess.js instance
    let board = null;           // chessboard.js instance
    let playerColor = 'white';  // цвет игрока
    let gameOver = false;
    let waitingForEngine = false;
    let initialized = false;
    let moveList = [];          // UCI-ходы для передачи движку
    let pendingPromotion = null;
    let waitingForHint = false;
    let resettingEngine = false;
    let searchGeneration = 0;
    let gameMode = 'human';
    let opponentEngine = 'old';
    let whiteEngine = 'old';
    let blackEngine = 'new';
    let arenaPaused = false;
    let arenaTimer = null;

    // ======================== Инициализация ========================
    function init() {
        if (initialized) return;

        // Загружаем настройки
        const settings = window.Settings ? window.Settings.load() : {};
        playerColor = settings.playerColor || 'white';
        gameMode = settings.gameMode === 'arena' ? 'arena' : 'human';
        opponentEngine = normalizeEngine(settings.opponentEngine, 'old');
        whiteEngine = normalizeEngine(settings.whiteEngine, 'old');
        blackEngine = normalizeEngine(settings.blackEngine, 'new');

        // chess.js
        chess = new Chess();

        // chessboard.js
        const boardConfig = {
            position: 'start',
            draggable: true,
            orientation: playerColor,
            pieceTheme: 'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png',
            onDragStart: onDragStart,
            onDrop: onDrop,
            onSnapEnd: onSnapEnd,
            moveSpeed: 200,
            snapbackSpeed: 300,
            snapSpeed: 100,
            showNotation: true
        };
        board = Chessboard('chess-board', boardConfig);

        // Адаптивный размер
        $(window).on('resize', function() {
            board.resize();
        });

        // Инициализация UI
        if (window.UI) {
            window.UI.init();
            window.UI.setCallbacks({
                onNewGame: newGame,
                onUndo: undoMove,
                onHint: hint,
                onFlipBoard: flipBoard,
                onSettingsChange: onSettingsChange,
                onPromotion: onPromotionChoice,
                onStartGame: startGame,
                onToggleArenaPause: toggleArenaPause,
                onTimeOut: onTimeOut
            });
            window.UI.updateTurnDisplay('white');
        }

        // Инициализация истории
        if (window.MoveHistory) {
            window.MoveHistory.init(chess.fen());
        }

        // Звук
        if (window.Sound) window.Sound.play('gameStart');

        // Запускаем таймеры
        if (window.UI) window.UI.startTimers();

        initialized = true;

        // Все части игры готовы до первого хода, в том числе при игре за чёрных.
        if (window.Bridge) {
            window.Bridge.setCallbacks({
                onReady: onEngineReady,
                onBestMove: onEngineBestMove,
                onInfo: onEngineInfo,
                onConnectionChange: onConnectionChange,
                onError: onEngineError,
                onProvidersChange: onProvidersChange,
                onProviderFallback: onProviderFallback
            });
            if (window.Bridge.getProviders) onProvidersChange(window.Bridge.getProviders());
            else onConnectionChange(window.Bridge.getRemoteConnected(), window.Bridge.getConnectionState());
            if (gameMode === 'arena' && !arenaAvailable()) pauseArena('Для матча нужны оба движка.');
            updateModeDisplay();
            if (window.Bridge.getEngineReady()) onEngineReady();
        }
    }

    // ======================== Обработчики доски (chessboard.js) ========================

    function onDragStart(source, piece, position, orientation) {
        // Запрет перетаскивания в неподходящих ситуациях
        if (gameOver || gameMode === 'arena') return false;
        if (waitingForEngine || waitingForHint) return false;

        // Только свои фигуры в свой ход
        if (chess.turn() === 'w' && piece.search(/^b/) !== -1) return false;
        if (chess.turn() === 'b' && piece.search(/^w/) !== -1) return false;

        // Только когда ход игрока
        var isPlayerTurn = (playerColor === 'white' && chess.turn() === 'w') ||
                           (playerColor === 'black' && chess.turn() === 'b');
        if (!isPlayerTurn) return false;

        return true;
    }

    function onDrop(source, target) {
        if (gameOver || gameMode === 'arena' || waitingForEngine || waitingForHint || isEngineTurn()) return 'snapback';
        if (source === target) return 'snapback';

        // Проверяем, является ли это превращением пешки
        var piece = chess.get(source);
        if (piece && piece.type === 'p') {
            var targetRank = target[1];
            if ((piece.color === 'w' && targetRank === '8') || (piece.color === 'b' && targetRank === '1')) {
                // Проверяем, что ход легален хотя бы с каким-то превращением
                var testMove = chess.move({ from: source, to: target, promotion: 'q' });
                if (testMove === null) return 'snapback';
                chess.undo(); // откатываем пробный ход

                // Сохраняем и показываем модальное окно выбора фигуры
                pendingPromotion = { from: source, to: target };
                if (window.UI) window.UI.openPromotionModal();
                return; // не возвращаем snapback — позиция обновится после выбора
            }
        }

        // Обычный ход
        var move = chess.move({ from: source, to: target, promotion: 'q' });
        if (move === null) return 'snapback';

        afterPlayerMove(move);
    }

    function onSnapEnd() {
        board.position(chess.fen());
    }

    // ======================== Превращение пешки ========================

    function onPromotionChoice(pieceType) {
        if (!pendingPromotion || gameOver || gameMode === 'arena') return;

        var move = chess.move({
            from: pendingPromotion.from,
            to: pendingPromotion.to,
            promotion: pieceType
        });
        pendingPromotion = null;

        if (move === null) {
            board.position(chess.fen());
            return;
        }

        afterPlayerMove(move);
        board.position(chess.fen());
    }

    // ======================== После хода игрока ========================

    function afterPlayerMove(move) {
        moveList.push(move.from + move.to + (move.promotion || ''));

        // Записываем в историю
        if (window.MoveHistory) {
            var from = { file: move.from.charCodeAt(0) - 97, rank: 8 - parseInt(move.from[1]) };
            var to = { file: move.to.charCodeAt(0) - 97, rank: 8 - parseInt(move.to[1]) };
            window.MoveHistory.addMove(move.san, move.from + move.to + (move.promotion || ''),
                from, to, move.piece, move.promotion, chess.fen());
        }

        // Звук
        playMoveSound(move);

        // Обновляем UI
        updateStatus();

        // Обновляем позицию доски
        board.position(chess.fen());

        // Проверяем окончание игры
        if (checkGameOver()) return;

        // Ход движка
        makeEngineMove();
    }

    // ======================== Движок ========================

    function onEngineReady() {
        if (gameMode === 'human') selectHumanEngine();
        if (window.UI) window.UI.setEngineStatus(true);

        if (initialized && !resettingEngine && !waitingForEngine && !waitingForHint &&
                !arenaPaused && !arenaTimer && isEngineTurn() && !gameOver) {
            makeEngineMove();
        }
    }

    function onConnectionChange(connected, state) {
        if (window.Bridge.getProviders) {
            if (window.UI) window.UI.setEngineStatus(window.Bridge.getEngineReady());
            return;
        }
        if (window.UI && window.UI.setConnectionStatus) {
            window.UI.setConnectionStatus(connected, state);
            window.UI.setEngineStatus(window.Bridge.getEngineReady());
        }
    }

    function normalizeEngine(engine, fallback) {
        return ['old', 'new', 'local'].indexOf(engine) !== -1 ? engine : fallback;
    }

    function arenaAvailable() {
        if (!window.Bridge.getProviders) return false;
        var providers = window.Bridge.getProviders();
        return !!(providers.old && providers.old.connected && providers.old.ready &&
            providers.new && providers.new.connected && providers.new.ready &&
            whiteEngine !== blackEngine && whiteEngine !== 'local' && blackEngine !== 'local');
    }

    function updateModeDisplay() {
        if (window.UI && window.UI.setGameMode) window.UI.setGameMode(gameMode, arenaPaused);
    }

    function setCurrentEngine(engine) {
        if (window.Bridge.setActiveEngine) window.Bridge.setActiveEngine(engine);
        if (window.UI && window.UI.setActiveEngine) window.UI.setActiveEngine(engine);
    }

    function selectHumanEngine() {
        if (window.Bridge.getProviders && !window.Bridge.getEngineReady(opponentEngine)) {
            var providers = window.Bridge.getProviders();
            if (providers.old.ready) opponentEngine = 'old';
            else if (providers.new.ready) opponentEngine = 'new';
            else if (window.Bridge.getEngineReady('local')) opponentEngine = 'local';
        }
        setCurrentEngine(opponentEngine);
        return opponentEngine;
    }

    function onProvidersChange(providers) {
        if (window.UI && window.UI.updateProviders) window.UI.updateProviders(providers);
        if (initialized && gameMode === 'human' && !waitingForEngine && !waitingForHint && !resettingEngine) {
            selectHumanEngine();
        }
        if (initialized && gameMode === 'arena' && !arenaPaused && !resettingEngine && !gameOver && !arenaAvailable()) {
            pauseArena('Матч приостановлен: один из движков недоступен.');
        }
    }

    function onProviderFallback(from, to) {
        if (gameMode === 'arena') {
            pauseArena('Матч приостановлен: выбранный движок недоступен.');
            return;
        }
        opponentEngine = to;
        setCurrentEngine(to);
        if (window.UI) {
            var name = to === 'old' ? 'Старый движок Марика' : to === 'new' ? 'Новый движок Марика' : 'Резервный движок';
            window.UI.showToast('Игра продолжится с движком: ' + name, 4000);
        }
    }

    function onEngineError(error) {
        if (gameMode === 'arena') {
            pauseArena('Матч приостановлен. Проверьте индикаторы движков и нажмите «Продолжить».');
            console.error('Engine unavailable:', error);
            return;
        }
        waitingForEngine = false;
        waitingForHint = false;
        cancelEngineSearch();
        if (window.UI) {
            window.UI.setEngineStatus(false);
            window.UI.showToast('Не удалось запустить движок. Попробуйте начать новую игру.', 5000);
        }
        console.error('Engine unavailable:', error);
    }

    function isEngineTurn() {
        if (gameMode === 'arena') return !!chess;
        return chess && chess.turn() !== (playerColor === 'white' ? 'w' : 'b');
    }

    function validateEngineMove(fen, moveStr) {
        if (typeof moveStr !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(moveStr)) return false;
        var position = new Chess(fen);
        return !!position.move({
            from: moveStr.substring(0, 2),
            to: moveStr.substring(2, 4),
            promotion: moveStr.length > 4 ? moveStr[4] : undefined
        });
    }

    function getEngineFEN(fen) {
        var fields = fen.split(' ');
        // chess-api.com принимает поле en passant только при возможном взятии.
        // chess.js 0.10.3 записывает его после любого двойного хода пешки.
        if (fields[3] !== '-') {
            var position = new Chess(fen);
            var canCaptureEnPassant = position.moves({ verbose: true }).some(function(move) {
                return move.flags.indexOf('e') !== -1;
            });
            if (!canCaptureEnPassant) fields[3] = '-';
        }
        return fields.join(' ');
    }

    function cancelEngineSearch() {
        clearTimeout(arenaTimer);
        arenaTimer = null;
        searchGeneration++;
        waitingForEngine = false;
        waitingForHint = false;
        if (window.Bridge) window.Bridge.stopSearch();
    }

    function makeEngineMove() {
        if (gameOver || arenaPaused || !isEngineTurn() || waitingForEngine) return;
        if (gameMode === 'arena' && !resettingEngine && !arenaAvailable()) {
            pauseArena('Матч приостановлен: для игры нужны оба движка.');
            return;
        }
        waitingForEngine = true;
        if (resettingEngine) return;

        var fen = chess.fen();
        var generation = ++searchGeneration;
        var engine = gameMode === 'arena' ? (chess.turn() === 'w' ? whiteEngine : blackEngine) : opponentEngine;
        if (gameMode === 'human' && !window.Bridge.getEngineReady(engine) && window.Bridge.getProviders) {
            var providers = window.Bridge.getProviders();
            var available = providers.old.ready ? 'old' : providers.new.ready ? 'new' : 'local';
            if (available !== engine) onProviderFallback(engine, available);
            engine = available;
        }
        setCurrentEngine(engine);
        window.Bridge.setPosition(getEngineFEN(fen));

        // Передаём оставшееся время для оптимального тайм-менеджмента Stockfish
        var whiteTimeMs = getTimerMs('white');
        var blackTimeMs = getTimerMs('black');

        var started = window.Bridge.startSearch({
            engine: engine,
            allowFallback: gameMode !== 'arena',
            movetime: gameMode === 'arena' ? 500 : undefined,
            wtime: whiteTimeMs,
            btime: blackTimeMs,
            validateMove: function(moveStr) { return validateEngineMove(fen, moveStr); },
            onBestMove: function(moveStr, ponder) {
                if (generation !== searchGeneration || chess.fen() !== fen || !waitingForEngine || arenaPaused) return;
                onEngineBestMove(moveStr, ponder);
            }
        });
        if (started === false && generation === searchGeneration) onEngineError('Движок занят.');
    }

    function getTimerMs(color) {
        if (window.UI && window.UI.getWhiteTime && window.UI.getBlackTime) {
            var seconds = color === 'white' ? window.UI.getWhiteTime() : window.UI.getBlackTime();
            return Math.max(0, Math.floor(seconds * 1000));
        }
        return 900000; // 15 min default
    }

    function onEngineBestMove(moveStr, ponder) {
        waitingForEngine = false;
        if (gameOver || arenaPaused || !moveStr || moveStr === '(none)') return;

        var from = moveStr.substring(0, 2);
        var to = moveStr.substring(2, 4);
        var promotion = moveStr.length > 4 ? moveStr[4] : undefined;

        var move = chess.move({ from: from, to: to, promotion: promotion });
        if (!move) {
            console.error('Engine returned illegal move:', moveStr);
            return;
        }

        moveList.push(moveStr);

        // Обновляем доску с анимацией
        board.position(chess.fen());

        // Записываем в историю
        if (window.MoveHistory) {
            var fromSq = { file: from.charCodeAt(0) - 97, rank: 8 - parseInt(from[1]) };
            var toSq = { file: to.charCodeAt(0) - 97, rank: 8 - parseInt(to[1]) };
            window.MoveHistory.addMove(move.san, moveStr, fromSq, toSq, move.piece, move.promotion, chess.fen());
        }

        // Звук
        playMoveSound(move);

        // Обновляем UI
        updateStatus();

        // Проверяем окончание
        if (!checkGameOver() && gameMode === 'arena' && !arenaPaused) {
            var generation = searchGeneration;
            arenaTimer = setTimeout(function() {
                arenaTimer = null;
                if (generation === searchGeneration && !gameOver && !arenaPaused) makeEngineMove();
            }, 300);
        }
    }

    function onEngineInfo(info) {
        if (window.UI) {
            var evalValue = info.mate ? (info.mate * 10000) : info.score;
            if (info.perspective === 'sideToMove' && chess.turn() === 'b') evalValue = -evalValue;
            window.UI.updateEngineInfo(
                info.depth,
                info.nodes,
                info.nps,
                info.pv ? info.pv.join(' ') : '',
                info.pv ? info.pv[0] : '',
                evalValue
            );
        }
    }

    // ======================== Статус и проверки ========================

    function updateStatus() {
        var turn = chess.turn() === 'w' ? 'white' : 'black';
        if (window.UI) window.UI.updateTurnDisplay(turn);
    }

    function checkGameOver() {
        if (gameOver) return true;
        var result = '1/2-1/2';
        var message;
        if (chess.in_checkmate()) {
            var winner = chess.turn() === 'w' ? 'Чёрные' : 'Белые';
            result = chess.turn() === 'w' ? '0-1' : '1-0';
            message = 'Мат! ' + winner + ' победили!';
        } else if (chess.in_stalemate()) {
            message = 'Пат! Ничья.';
        } else if (chess.in_threefold_repetition()) {
            message = 'Троекратное повторение! Ничья.';
        } else if (chess.insufficient_material()) {
            message = 'Недостаточно фигур! Ничья.';
        } else if (chess.in_draw()) {
            message = 'Ничья по правилу 50 ходов.';
        } else return false;

        gameOver = true;
        cancelEngineSearch();
        if (window.MoveHistory) window.MoveHistory.setResult(result);
        if (window.UI) {
            window.UI.setGameOver(true);
            window.UI.showGameOverMessage(message);
        }
        if (window.Sound) window.Sound.play('gameEnd');
        return true;
    }

    // ======================== Звуки ========================

    function playMoveSound(move) {
        if (!window.Sound) return;
        if (move.flags.includes('k') || move.flags.includes('q')) {
            window.Sound.play('castle');
        } else if (move.flags.includes('c') || move.flags.includes('e')) {
            window.Sound.play('capture');
        } else if (move.flags.includes('p')) {
            window.Sound.play('promotion');
        } else {
            window.Sound.play('move');
        }
        // Шах
        if (chess.in_check()) {
            setTimeout(function() { window.Sound.play('check'); }, 100);
        }
    }

    // ======================== Действия пользователя ========================

    function newGame() {
        cancelEngineSearch();
        var generation = searchGeneration;
        resettingEngine = true;
        arenaPaused = false;
        chess = new Chess();
        moveList = [];
        gameOver = false;
        waitingForEngine = false;
        pendingPromotion = null;

        updateModeDisplay();
        board.orientation(playerColor);
        board.position('start');

        if (window.MoveHistory) window.MoveHistory.init(chess.fen());
        if (window.UI) {
            window.UI.updateTurnDisplay('white');
            window.UI.setGameOver(false);
            window.UI.startTimers();
        }
        if (window.Sound) window.Sound.play('gameStart');

        waitingForEngine = gameMode === 'arena' || playerColor === 'black';
        // Каждая новая партия заново проверяет доступность удалённого движка.
        return Promise.resolve(window.Bridge.newGame()).then(function() {
            if (generation !== searchGeneration) return;
            resettingEngine = false;
            waitingForEngine = false;
            if (!window.Bridge.getEngineReady()) return;
            if (gameMode === 'arena' && !arenaAvailable()) {
                pauseArena('Для матча нужны оба движка. Выберите игру против одного движка или повторите подключение.');
                return;
            }
            if (gameMode === 'arena') setCurrentEngine(whiteEngine);
            else selectHumanEngine();
            if (isEngineTurn() && !gameOver) makeEngineMove();
        }).catch(function(error) {
            if (generation !== searchGeneration) return;
            resettingEngine = false;
            onEngineError(error);
        });
    }

    function undoMove() {
        if (gameMode === 'arena' || gameOver || waitingForEngine || waitingForHint || resettingEngine) return false;
        // Первый ход движка за белых не образует пару с ходом игрока.
        if (chess.history().length < 2) return false;

        // Откатываем 2 хода (ход движка + ход игрока)
        var undone1 = chess.undo();
        var undone2 = chess.undo();
        if (!undone1 && !undone2) return false;

        // Восстанавливаем moveList
        if (undone1) moveList.pop();
        if (undone2) moveList.pop();

        board.position(chess.fen());
        updateStatus();

        if (window.MoveHistory) {
            window.MoveHistory.undo();
            if (undone2) window.MoveHistory.undo();
        }

        return true;
    }

    function hint() {
        if (gameMode === 'arena' || waitingForEngine || waitingForHint || resettingEngine || gameOver || isEngineTurn()) return;

        var fen = chess.fen();
        var generation = ++searchGeneration;
        waitingForHint = true;
        window.Bridge.setPosition(getEngineFEN(fen));
        window.Bridge.startSearch({
            movetime: 1000,
            engine: opponentEngine,
            allowFallback: true,
            validateMove: function(moveStr) { return validateEngineMove(fen, moveStr); },
            onBestMove: function(moveStr) {
                if (generation !== searchGeneration || chess.fen() !== fen || gameOver) return;
                waitingForHint = false;
                // Подсветим ход на доске через greySquare
                if (moveStr && moveStr.length >= 4) {
                    var from = moveStr.substring(0, 2);
                    var to = moveStr.substring(2, 4);
                    highlightSquare(from);
                    highlightSquare(to);
                    setTimeout(function() { removeHighlights(); }, 2000);
                }
            }
        });
    }

    function highlightSquare(square) {
        var el = $('#chess-board .square-' + square);
        el.css('background', 'radial-gradient(circle, rgba(46,204,113,0.6) 40%, transparent 70%)');
    }

    function removeHighlights() {
        $('#chess-board .square-55d63').css('background', '');
        // Перерисовываем доску чтобы убрать подсветку
        board.position(chess.fen());
    }

    function flipBoard() {
        board.flip();
    }

    function onSettingsChange(settings) {
        playerColor = settings.playerColor || 'white';
        if (window.Settings) {
            window.Settings.set('playerColor', playerColor);
            if (settings.soundEnabled !== undefined) window.Settings.set('soundEnabled', settings.soundEnabled);
            if (settings.showCoordinates !== undefined) window.Settings.set('showCoordinates', settings.showCoordinates);
            if (settings.gameTime !== undefined) window.Settings.set('gameTime', settings.gameTime);
        }
    }

    function setPositionFromHistory(fen) {
        if (gameMode === 'arena') pauseArena();
        cancelEngineSearch();
        resettingEngine = false;
        pendingPromotion = null;
        chess.load(fen);
        board.position(fen);
        updateStatus();
    }

    function getCurrentFEN() {
        return chess.fen();
    }

    function startGame(config) {
        config = config || {};
        var mode = config.mode === 'arena' ? 'arena' : 'human';
        var white = normalizeEngine(config.whiteEngine, 'old');
        var black = normalizeEngine(config.blackEngine, 'new');
        if (mode === 'arena') {
            var providers = window.Bridge.getProviders ? window.Bridge.getProviders() : {};
            if (white === black || white === 'local' || black === 'local') {
                if (window.UI) window.UI.showToast('Для матча выберите два разных движка.', 4000);
                return false;
            }
            if (!providers.old || !providers.old.ready || !providers.old.connected ||
                    !providers.new || !providers.new.ready || !providers.new.connected) {
                if (window.UI) window.UI.showToast('Для матча нужны оба движка с зелёными индикаторами.', 4000);
                return false;
            }
        }
        gameMode = mode;
        opponentEngine = normalizeEngine(config.opponentEngine, 'old');
        whiteEngine = white;
        blackEngine = black;
        if (window.Settings && window.Settings.set) {
            window.Settings.set('gameMode', gameMode);
            window.Settings.set('opponentEngine', opponentEngine);
            window.Settings.set('whiteEngine', whiteEngine);
            window.Settings.set('blackEngine', blackEngine);
        }
        if (window.BurchessSettings) {
            Object.assign(window.BurchessSettings, { gameMode: gameMode, opponentEngine: opponentEngine,
                whiteEngine: whiteEngine, blackEngine: blackEngine });
        }
        return newGame();
    }

    function pauseArena(message) {
        if (gameMode !== 'arena' || arenaPaused || gameOver) return false;
        arenaPaused = true;
        cancelEngineSearch();
        if (window.UI && window.UI.pauseTimers) window.UI.pauseTimers();
        updateModeDisplay();
        if (message && window.UI) window.UI.showToast(message, 5000);
        return true;
    }

    function toggleArenaPause() {
        if (gameMode !== 'arena' || gameOver || resettingEngine) return false;
        if (!arenaPaused) return pauseArena();
        cancelEngineSearch();
        var generation = searchGeneration;
        resettingEngine = true;
        return Promise.resolve(window.Bridge.newGame()).then(function() {
            if (generation !== searchGeneration) return false;
            resettingEngine = false;
            if (!arenaAvailable()) {
                if (window.UI) window.UI.showToast('Оба движка должны быть подключены для продолжения матча.', 4000);
                return false;
            }
            arenaPaused = false;
            if (window.UI && window.UI.resumeTimers) window.UI.resumeTimers();
            updateModeDisplay();
            makeEngineMove();
            return true;
        }).catch(function(error) {
            if (generation !== searchGeneration) return false;
            resettingEngine = false;
            onEngineError(error);
            return false;
        });
    }

    function onTimeOut(color) {
        if (gameOver) return;
        gameOver = true;
        cancelEngineSearch();
        if (window.MoveHistory) window.MoveHistory.setResult(color === 'white' ? '0-1' : '1-0');
        if (window.UI) window.UI.setGameOver(true);
        if (window.Sound) window.Sound.play('gameEnd');
    }

    // ======================== Публичный API ========================

    window.Game = {
        init: init,
        makeMove: function(from, to, promotion) {
            if (gameOver || gameMode === 'arena' || waitingForEngine || waitingForHint || isEngineTurn()) return false;
            var move = chess.move({ from: from, to: to, promotion: promotion || 'q' });
            if (move) {
                afterPlayerMove(move);
                board.position(chess.fen());
            }
            return !!move;
        },
        newGame: newGame,
        startGame: startGame,
        toggleArenaPause: toggleArenaPause,
        getGameMode: function() { return gameMode; },
        getArenaPaused: function() { return arenaPaused; },
        setPositionFromHistory: setPositionFromHistory,
        getCurrentFEN: getCurrentFEN,
        undo: undoMove,
        hint: hint,
        isGameOver: function() { return gameOver; }
    };
})();
