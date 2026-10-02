/**
 * UI.js — управление пользовательским интерфейсом BURCHESS
 * Версия: 3.0
 */

(function() {
    'use strict';

    const UI = {
        elements: {},
        isDarkTheme: false,
        isFullscreen: false,
        timers: {
            white: null,
            black: null,
            whiteTime: 15 * 60,
            blackTime: 15 * 60,
            active: false
        },
        callbacks: {
            onNewGame: null,
            onUndo: null,
            onHint: null,
            onFlipBoard: null,
            onSettingsChange: null,
            onPromotion: null,
            onStartGame: null,
            onToggleArenaPause: null,
            onTimeOut: null
        },
        currentTurn: 'white',
        connectionState: 'connecting',
        providers: null,
        activeEngine: 'old',
        gameMode: 'human',
        arenaPaused: false,
        engineActive: false,
        gameOver: false,
        toastTimeout: null
    };

    function init() {
        cacheElements();
        attachEventListeners();
        loadSettings();
        applyTheme();
        updateTurnDisplay('white');
        updateTimersDisplay();
        setupModalClosers();
        if (UI.providers) updateProviders(UI.providers);
        else updateSetupControls();
    }

    function cacheElements() {
        var e = UI.elements;
        e.app = document.querySelector('.app');
        e.turnIndicator = document.getElementById('turn-indicator');
        e.turnText = document.querySelector('.turn-text');
        e.turnPiece = document.querySelector('.turn-piece');
        e.whiteTimer = document.getElementById('white-timer');
        e.blackTimer = document.getElementById('black-timer');
        e.evalFill = document.getElementById('eval-fill');
        e.evalNumeric = document.getElementById('eval-numeric');
        e.moveList = document.getElementById('move-list');
        e.engineThought = document.getElementById('engine-thought');
        e.pvLine = document.getElementById('pv-line');
        e.nodesCount = document.getElementById('nodes-count');
        e.nps = document.getElementById('nps');
        e.depthBadge = document.getElementById('search-depth');
        e.flipBoardBtn = document.getElementById('flip-board-btn');
        e.undoBtn = document.getElementById('undo-btn');
        e.newGameBtn = document.getElementById('new-game-btn');
        e.settingsBtn = document.getElementById('settings-btn');
        e.hintBtn = document.getElementById('hint-btn');
        e.fullscreenBtn = document.getElementById('fullscreen-btn');
        e.themeToggle = document.getElementById('theme-toggle');
        e.clearHistoryBtn = document.getElementById('clear-history-btn');

        e.settingsModal = document.getElementById('settings-modal');
        e.promotionModal = document.getElementById('promotion-modal');
        e.gameOverModal = document.getElementById('game-over-modal');
        e.toast = document.getElementById('toast-message');

        e.playerColor = document.getElementById('player-color');
        e.gameTime = document.getElementById('game-time');
        e.soundToggle = document.getElementById('sound-toggle');
        e.showCoordinates = document.getElementById('show-coordinates');
        e.saveSettings = document.getElementById('save-settings');
        e.resetDefaults = document.getElementById('reset-defaults');

        e.promotionBtns = document.querySelectorAll('.promo-btn');
        e.gameOverNewGame = document.getElementById('game-over-new-game');
        e.engineStatus = document.getElementById('engine-status');
        e.gameMode = document.getElementById('game-mode');
        e.opponentEngine = document.getElementById('opponent-engine');
        e.whiteEngine = document.getElementById('white-engine');
        e.blackEngine = document.getElementById('black-engine');
        e.humanEngineField = document.getElementById('human-engine-field');
        e.arenaEngineFields = document.getElementById('arena-engine-fields');
        e.startGameBtn = document.getElementById('start-game-btn');
        e.arenaPauseBtn = document.getElementById('arena-pause-btn');
        e.setupMessage = document.getElementById('game-setup-message');
    }

    function attachEventListeners() {
        var e = UI.elements;
        if (e.flipBoardBtn) e.flipBoardBtn.addEventListener('click', function() { if (UI.callbacks.onFlipBoard) UI.callbacks.onFlipBoard(); });
        if (e.undoBtn) e.undoBtn.addEventListener('click', function() { if (UI.callbacks.onUndo) UI.callbacks.onUndo(); });
        if (e.newGameBtn) e.newGameBtn.addEventListener('click', function() { if (UI.callbacks.onNewGame) UI.callbacks.onNewGame(); });
        if (e.settingsBtn) e.settingsBtn.addEventListener('click', function() { openModal('settings'); });
        if (e.hintBtn) e.hintBtn.addEventListener('click', function() { if (UI.callbacks.onHint) UI.callbacks.onHint(); });
        if (e.fullscreenBtn) e.fullscreenBtn.addEventListener('click', toggleFullscreen);
        if (e.themeToggle) e.themeToggle.addEventListener('click', toggleTheme);
        if (e.clearHistoryBtn) e.clearHistoryBtn.addEventListener('click', clearMoveHistory);
        if (e.saveSettings) e.saveSettings.addEventListener('click', saveSettings);
        if (e.resetDefaults) e.resetDefaults.addEventListener('click', resetSettings);
        if (e.gameMode) e.gameMode.addEventListener('change', updateSetupControls);
        if (e.opponentEngine) e.opponentEngine.addEventListener('change', updateSetupControls);
        if (e.whiteEngine) e.whiteEngine.addEventListener('change', function() {
            if (e.blackEngine && e.whiteEngine.value === e.blackEngine.value) {
                e.blackEngine.value = e.whiteEngine.value === 'old' ? 'new' : 'old';
            }
            updateSetupControls();
        });
        if (e.blackEngine) e.blackEngine.addEventListener('change', function() {
            if (e.whiteEngine && e.blackEngine.value === e.whiteEngine.value) {
                e.whiteEngine.value = e.blackEngine.value === 'old' ? 'new' : 'old';
            }
            updateSetupControls();
        });
        if (e.startGameBtn) e.startGameBtn.addEventListener('click', function() {
            if (!e.startGameBtn.disabled && UI.callbacks.onStartGame) UI.callbacks.onStartGame(getGameSetup());
        });
        if (e.arenaPauseBtn) e.arenaPauseBtn.addEventListener('click', function() {
            if (UI.callbacks.onToggleArenaPause) UI.callbacks.onToggleArenaPause();
        });
        if (e.gameOverNewGame) e.gameOverNewGame.addEventListener('click', function() {
            closeModal('gameOver');
            if (UI.callbacks.onNewGame) UI.callbacks.onNewGame();
        });

        e.promotionBtns.forEach(function(btn) {
            btn.addEventListener('click', function() {
                var piece = btn.getAttribute('data-piece');
                if (UI.callbacks.onPromotion) UI.callbacks.onPromotion(piece);
                closeModal('promotion');
            });
        });

        var modals = ['settings', 'promotion', 'gameOver'];
        modals.forEach(function(modal) {
            var modalElement = UI.elements[modal + 'Modal'];
            if (modalElement) {
                var closeBtn = modalElement.querySelector('.close');
                if (closeBtn) closeBtn.addEventListener('click', function() { closeModal(modal); });
                modalElement.addEventListener('click', function(ev) {
                    if (ev.target === modalElement) closeModal(modal);
                });
            }
        });
    }

    function openModal(modalName) {
        var modal = UI.elements[modalName + 'Modal'];
        if (modal) modal.style.display = 'flex';
    }

    function closeModal(modalName) {
        var modal = UI.elements[modalName + 'Modal'];
        if (modal) modal.style.display = 'none';
    }

    function setupModalClosers() {
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                closeModal('settings');
                closeModal('promotion');
                closeModal('gameOver');
            }
        });
    }

    // ======================== Настройки ========================
    function loadSettings() {
        var defaults = {
            playerColor: 'white',
            gameTime: 15,
            soundEnabled: true,
            showCoordinates: true,
            theme: 'light',
            gameMode: 'human',
            opponentEngine: 'old',
            whiteEngine: 'old',
            blackEngine: 'new'
        };
        var settings;
        try {
            var stored = localStorage.getItem('burchess_settings');
            if (stored) {
                settings = JSON.parse(stored);
                settings = Object.assign({}, defaults, settings);
            } else {
                settings = Object.assign({}, defaults);
            }
        } catch(e) {
            settings = Object.assign({}, defaults);
        }

        if (UI.elements.playerColor) UI.elements.playerColor.value = settings.playerColor;
        if (UI.elements.gameTime) UI.elements.gameTime.value = settings.gameTime || 15;
        if (UI.elements.soundToggle) UI.elements.soundToggle.checked = settings.soundEnabled;
        if (UI.elements.showCoordinates) UI.elements.showCoordinates.checked = settings.showCoordinates;
        if (UI.elements.gameMode) UI.elements.gameMode.value = settings.gameMode === 'arena' ? 'arena' : 'human';
        if (UI.elements.opponentEngine) UI.elements.opponentEngine.value = settings.opponentEngine === 'new' ? 'new' : 'old';
        if (UI.elements.whiteEngine) UI.elements.whiteEngine.value = settings.whiteEngine === 'new' ? 'new' : 'old';
        if (UI.elements.blackEngine) UI.elements.blackEngine.value = settings.blackEngine === 'old' ? 'old' : 'new';

        UI.isDarkTheme = (settings.theme === 'dark');
        if (UI.isDarkTheme) document.documentElement.setAttribute('data-theme', 'dark');
        else document.documentElement.removeAttribute('data-theme');

        window.BurchessSettings = settings;
    }

    function saveSettings() {
        var settings = Object.assign({}, window.BurchessSettings || {}, {
            playerColor: UI.elements.playerColor ? UI.elements.playerColor.value : 'white',
            gameTime: UI.elements.gameTime ? parseInt(UI.elements.gameTime.value) : 15,
            soundEnabled: UI.elements.soundToggle ? UI.elements.soundToggle.checked : true,
            showCoordinates: UI.elements.showCoordinates ? UI.elements.showCoordinates.checked : true,
            theme: UI.isDarkTheme ? 'dark' : 'light'
        });
        try { localStorage.setItem('burchess_settings', JSON.stringify(settings)); } catch (error) {}
        window.BurchessSettings = settings;
        closeModal('settings');
        showToast('Настройки сохранены', 2000);
        if (UI.callbacks.onSettingsChange) UI.callbacks.onSettingsChange(settings);
    }

    function resetSettings() {
        if (UI.elements.playerColor) UI.elements.playerColor.value = 'white';
        if (UI.elements.gameTime) UI.elements.gameTime.value = 15;
        if (UI.elements.soundToggle) UI.elements.soundToggle.checked = true;
        if (UI.elements.showCoordinates) UI.elements.showCoordinates.checked = true;
        showToast('Настройки сброшены', 1500);
    }

    // ======================== Тема ========================
    function applyTheme() {
        if (UI.isDarkTheme) {
            document.documentElement.setAttribute('data-theme', 'dark');
            if (UI.elements.themeToggle) UI.elements.themeToggle.textContent = '☀️';
        } else {
            document.documentElement.removeAttribute('data-theme');
            if (UI.elements.themeToggle) UI.elements.themeToggle.textContent = '🌙';
        }
    }

    function toggleTheme() {
        UI.isDarkTheme = !UI.isDarkTheme;
        applyTheme();
        if (window.BurchessSettings) {
            window.BurchessSettings.theme = UI.isDarkTheme ? 'dark' : 'light';
            try {
                localStorage.setItem('burchess_settings', JSON.stringify(window.BurchessSettings));
            } catch(e) {}
        }
    }

    function toggleFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(function() {});
            UI.isFullscreen = true;
            if (UI.elements.fullscreenBtn) UI.elements.fullscreenBtn.textContent = '✕';
        } else {
            document.exitFullscreen();
            UI.isFullscreen = false;
            if (UI.elements.fullscreenBtn) UI.elements.fullscreenBtn.textContent = '⛶';
        }
    }

    document.addEventListener('fullscreenchange', function() {
        UI.isFullscreen = !!document.fullscreenElement;
        if (UI.elements.fullscreenBtn) {
            UI.elements.fullscreenBtn.textContent = UI.isFullscreen ? '✕' : '⛶';
        }
    });

    // ======================== Таймеры ========================
    var activeTimerColor = null;
    var timerUpdatedAt = null;

    function timerNow() {
        return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    }

    function remainingTime(color) {
        var seconds = color === 'white' ? UI.timers.whiteTime : UI.timers.blackTime;
        if (UI.timers.active && activeTimerColor === color && timerUpdatedAt !== null) {
            seconds -= Math.max(0, timerNow() - timerUpdatedAt) / 1000;
        }
        return Math.max(0, seconds);
    }

    function settleTimer(reportExpiry) {
        if (!UI.timers.active || activeTimerColor === null || timerUpdatedAt === null) return;
        var color = activeTimerColor;
        var now = timerNow();
        var key = color === 'white' ? 'whiteTime' : 'blackTime';
        UI.timers[key] = Math.max(0, UI.timers[key] - Math.max(0, now - timerUpdatedAt) / 1000);
        timerUpdatedAt = now;
        if (reportExpiry !== false && UI.timers[key] <= 0) onTimeOut(color);
    }

    function clearTimerIntervals() {
        if (UI.timers.white !== null) clearInterval(UI.timers.white);
        if (UI.timers.black !== null) clearInterval(UI.timers.black);
        UI.timers.white = null;
        UI.timers.black = null;
    }

    function startTimers() {
        stopTimers(false);
        UI.timers.active = true;
        var gameTime = (window.BurchessSettings && window.BurchessSettings.gameTime) || 15;
        UI.timers.whiteTime = gameTime * 60;
        UI.timers.blackTime = gameTime * 60;
        updateTimersDisplay();
        startActiveTimer();
    }

    function stopTimers(reportExpiry) {
        settleTimer(reportExpiry);
        UI.timers.active = false;
        clearTimerIntervals();
        activeTimerColor = null;
        timerUpdatedAt = null;
        updateTimersDisplay();
    }

    function pauseTimers() {
        stopTimers();
    }

    function resumeTimers() {
        if (UI.gameOver) return;
        UI.timers.active = true;
        startActiveTimer();
    }

    function startActiveTimer() {
        if (!UI.timers.active || UI.gameOver) return;
        // A side can move again before the next display tick. Settle its exact
        // elapsed time now, retaining fractions of a second across every turn.
        settleTimer();
        if (!UI.timers.active || UI.gameOver) return;
        clearTimerIntervals();
        var color = UI.currentTurn;
        activeTimerColor = color;
        timerUpdatedAt = timerNow();
        updateTimersDisplay();
        var interval = setInterval(function() {
            if (!UI.timers.active || UI.gameOver) {
                clearInterval(interval);
                return;
            }
            settleTimer();
            updateTimersDisplay();
        }, 250);
        if (color === 'white') UI.timers.white = interval;
        else UI.timers.black = interval;
    }

    function updateTimersDisplay() {
        if (UI.elements.whiteTimer) UI.elements.whiteTimer.textContent = formatTime(remainingTime('white'));
        if (UI.elements.blackTimer) UI.elements.blackTimer.textContent = formatTime(remainingTime('black'));
    }

    function formatTime(seconds) {
        // Round the display to milliseconds before rounding up to full seconds,
        // so floating point residue after rapid turns cannot show an extra second.
        seconds = Math.ceil(Math.max(0, Math.round(seconds * 1000) / 1000));
        var mins = Math.floor(seconds / 60);
        var secs = seconds % 60;
        return (mins < 10 ? '0' : '') + mins + ':' + (secs < 10 ? '0' : '') + secs;
    }

    function onTimeOut(color) {
        if (UI.gameOver) return;
        UI.gameOver = true;
        UI.timers.active = false;
        stopTimers();
        var winner = color === 'white' ? 'Чёрные' : 'Белые';
        showGameOverMessage(winner + ' выиграли по времени!');
        if (UI.callbacks.onTimeOut) UI.callbacks.onTimeOut(color);
    }

    // ======================== Статус ========================
    function updateTurnDisplay(turn) {
        UI.currentTurn = turn;
        if (UI.elements.turnText) {
            UI.elements.turnText.textContent = turn === 'white' ? 'Ход белых' : 'Ход чёрных';
        }
        if (UI.elements.turnPiece) {
            UI.elements.turnPiece.textContent = turn === 'white' ? '♔' : '♚';
        }
        if (UI.timers.active && !UI.gameOver) {
            startActiveTimer();
        }
    }

    function updateEngineInfo(depth, nodes, nps, pv, bestMove, evalValue) {
        if (UI.elements.depthBadge) UI.elements.depthBadge.textContent = 'Глубина: ' + depth;
        if (UI.elements.nodesCount) UI.elements.nodesCount.textContent = 'Узлов: ' + (nodes ? nodes.toLocaleString() : '0');
        if (UI.elements.nps) UI.elements.nps.textContent = 'NPS: ' + (nps ? nps.toLocaleString() : '0');
        if (UI.elements.engineThought) {
            var thought = bestMove ? ('Лучший ход: ' + bestMove) : 'Анализ...';
            if (evalValue !== undefined) {
                var evalStr;
                if (Math.abs(evalValue) >= 10000) {
                    var mate = Math.round(evalValue / 10000);
                    evalStr = (mate > 0 ? '#' : '-#') + Math.abs(mate);
                } else {
                    evalStr = (evalValue / 100).toFixed(2);
                    if (evalValue > 0) evalStr = '+' + evalStr;
                }
                thought += ' | Оценка: ' + evalStr;
            }
            UI.elements.engineThought.textContent = thought;
        }
        if (UI.elements.pvLine) {
            UI.elements.pvLine.textContent = pv ? ('Вариант: ' + pv) : '';
        }
        // Обновляем шкалу оценки
        if (evalValue !== undefined) {
            var percent = Math.min(100, Math.max(0, 50 + (evalValue / 500) * 50));
            if (UI.elements.evalFill) UI.elements.evalFill.style.width = percent + '%';
            if (UI.elements.evalNumeric) {
                var displayVal;
                if (Math.abs(evalValue) >= 10000) {
                    var m = Math.round(evalValue / 10000);
                    displayVal = (m > 0 ? '#' : '-#') + Math.abs(m);
                } else {
                    displayVal = (evalValue / 100).toFixed(2);
                    if (evalValue > 0) displayVal = '+' + displayVal;
                }
                UI.elements.evalNumeric.textContent = displayVal;
            }
        }
    }

    function clearMoveHistory() {
        if (UI.elements.moveList) UI.elements.moveList.innerHTML = '';
    }

    function showGameOverMessage(message) {
        var titleElem = document.getElementById('game-over-title');
        var msgElem = document.getElementById('game-over-message');
        if (titleElem) titleElem.textContent = 'Игра окончена';
        if (msgElem) msgElem.textContent = message;
        openModal('gameOver');
    }

    function showToast(message, duration) {
        duration = duration || 2000;
        if (!UI.elements.toast) return;
        UI.elements.toast.textContent = message;
        UI.elements.toast.classList.add('show');
        if (UI.toastTimeout) clearTimeout(UI.toastTimeout);
        UI.toastTimeout = setTimeout(function() {
            UI.elements.toast.classList.remove('show');
        }, duration);
    }

    function setEngineStatus(active) {
        UI.engineActive = active;
        var led = UI.elements.engineStatus ? UI.elements.engineStatus.querySelector('.status-led') : null;
        if (led) {
            led.style.backgroundColor = active ? '#2ecc71' : '#e74c3c';
        }
        updateEngineStatusText();
    }

    function updateEngineStatusText() {
        var element = UI.elements.engineStatus || document.getElementById('engine-status');
        var label = element ? element.querySelector('.engine-status-text') : null;
        if (!label) return;
        var name = engineName(UI.activeEngine);
        label.textContent = name + (UI.engineActive ? ' активен' : ' загружается...');
    }

    function engineName(id) {
        return id === 'old' ? 'Старый движок Марика' : id === 'new' ? 'Новый движок Марика' : 'Резервный движок';
    }

    function updateProviders(providers) {
        UI.providers = providers;
        ['old', 'new'].forEach(function(id) {
            var provider = providers && providers[id];
            var connected = !!(provider && provider.connected);
            var connecting = !!(provider && provider.state === 'connecting');
            var description = engineName(id) + ': ' + (connected ? 'подключён' : connecting ? 'подключение' : 'недоступен');
            var element = document.getElementById('connection-status-' + id);
            if (element) {
                element.classList.toggle('connected', connected);
                element.classList.toggle('connecting', connecting);
                element.setAttribute('title', description);
                element.setAttribute('aria-label', description);
            }
            var text = document.getElementById('connection-status-' + id + '-text');
            if (text) text.textContent = description;
        });
        updateSetupControls();
    }

    function providerReady(id) {
        var provider = UI.providers && UI.providers[id];
        return !!(provider && provider.connected && provider.ready);
    }

    function updateSetupControls() {
        var e = UI.elements;
        if (!e.gameMode) return;
        var oldReady = providerReady('old');
        var newReady = providerReady('new');
        var connecting = !!(UI.providers && ['old', 'new'].some(function(id) {
            return UI.providers[id] && UI.providers[id].state === 'connecting';
        }));
        if (e.opponentEngine) {
            Array.from(e.opponentEngine.options).forEach(function(option) {
                if (option.value === 'old' || option.value === 'new') option.disabled = !providerReady(option.value);
            });
            var localOption = e.opponentEngine.querySelector('option[value="local"]');
            if (!oldReady && !newReady && !localOption) {
                localOption = document.createElement('option');
                localOption.value = 'local';
                localOption.textContent = engineName('local');
                e.opponentEngine.appendChild(localOption);
            }
            if ((oldReady || newReady) && localOption) localOption.remove();
            if (!providerReady(e.opponentEngine.value)) {
                e.opponentEngine.value = oldReady ? 'old' : newReady ? 'new' : 'local';
            }
        }
        [e.whiteEngine, e.blackEngine].forEach(function(select) {
            if (!select) return;
            Array.from(select.options).forEach(function(option) { option.disabled = !providerReady(option.value); });
        });
        var arena = e.gameMode.value === 'arena';
        if (e.humanEngineField) e.humanEngineField.hidden = arena;
        if (e.arenaEngineFields) e.arenaEngineFields.hidden = !arena;
        if (e.startGameBtn) e.startGameBtn.disabled = arena && !(oldReady && newReady);
        if (e.arenaPauseBtn) {
            e.arenaPauseBtn.hidden = UI.gameMode !== 'arena';
            e.arenaPauseBtn.textContent = UI.arenaPaused ? '▶ Продолжить' : '⏸ Пауза';
            e.arenaPauseBtn.disabled = UI.gameOver;
        }
        if (e.setupMessage) {
            e.setupMessage.textContent = arena
                ? oldReady && newReady ? 'Выберите цвета движков и начните партию.'
                    : UI.gameMode === 'arena' && UI.arenaPaused ? 'Партия на паузе. Нажмите «Продолжить», чтобы проверить оба подключения.'
                    : 'Для партии двух движков нужны оба подключения.'
                : oldReady && newReady ? 'Оба движка доступны. Выберите соперника и начните новую партию.'
                : oldReady || newReady ? 'Доступен один движок Марика. Соперник выбран автоматически.'
                : connecting ? 'Проверка доступности движков...' : 'Оба подключения недоступны. Можно играть с резервным движком.';
        }
    }

    function getGameSetup() {
        var e = UI.elements;
        return {
            mode: e.gameMode ? e.gameMode.value : 'human',
            opponentEngine: e.opponentEngine ? e.opponentEngine.value : 'old',
            whiteEngine: e.whiteEngine ? e.whiteEngine.value : 'old',
            blackEngine: e.blackEngine ? e.blackEngine.value : 'new'
        };
    }

    function setActiveEngine(id) {
        UI.activeEngine = id;
        updateEngineStatusText();
    }

    function setGameMode(mode, paused) {
        UI.gameMode = mode === 'arena' ? 'arena' : 'human';
        UI.arenaPaused = !!paused;
        if (UI.elements.gameMode) UI.elements.gameMode.value = UI.gameMode;
        if (UI.elements.undoBtn) UI.elements.undoBtn.disabled = UI.gameMode === 'arena';
        if (UI.elements.hintBtn) UI.elements.hintBtn.disabled = UI.gameMode === 'arena';
        updateSetupControls();
    }

    function setConnectionStatus(connected, state) {
        UI.connectionState = connected ? 'remote' : (state || 'local');
        var providers = Object.assign({}, UI.providers || {});
        providers.old = { connected: !!connected, ready: !!connected, state: state === 'connecting' ? 'connecting' : connected ? 'ready' : 'unavailable' };
        updateProviders(providers);
    }

    function setGameOver(over) {
        UI.gameOver = over;
        if (over) stopTimers();
        updateSetupControls();
    }

    function openPromotionModal() {
        openModal('promotion');
    }

    // ======================== Публичный API ========================
    window.UI = {
        init: init,
        updateTurnDisplay: updateTurnDisplay,
        updateEngineInfo: updateEngineInfo,
        clearMoveHistory: clearMoveHistory,
        showGameOverMessage: showGameOverMessage,
        showToast: showToast,
        setEngineStatus: setEngineStatus,
        setConnectionStatus: setConnectionStatus,
        updateProviders: updateProviders,
        setActiveEngine: setActiveEngine,
        setGameMode: setGameMode,
        getGameSetup: getGameSetup,
        setGameOver: setGameOver,
        openPromotionModal: openPromotionModal,
        startTimers: startTimers,
        stopTimers: stopTimers,
        pauseTimers: pauseTimers,
        resumeTimers: resumeTimers,
        setCallbacks: function(callbacks) {
            Object.assign(UI.callbacks, callbacks);
        },
        getSettings: function() { return window.BurchessSettings; },
        refreshBoard: function() {},
        // Геттеры для таймеров (используются в game.js для передачи времени Stockfish)
        getWhiteTime: function() { return remainingTime('white'); },
        getBlackTime: function() { return remainingTime('black'); }
    };
})();
