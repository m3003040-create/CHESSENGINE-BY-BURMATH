/**
 * sound.js — звуковые эффекты для BURCHESS
 * Версия: 2.0
 * Модуль отвечает за:
 * - генерацию и воспроизведение звуков через Web Audio API
 * - поддержку различных событий: ход, взятие, шах, рокировка, превращение, начало/конец игры
 * - уважение глобальной настройки звука (mute)
 * - кэширование буферов для быстрого воспроизведения
 * - синтез звуков на лету (без внешних файлов)
 * - фоновую музыку (опционально)
 */

(function() {
    'use strict';

    // ======================== Конфигурация ========================
    const SoundConfig = {
        enabled: true,               // общий выключатель (из настроек)
        volume: 0.5,                // громкость 0-1
        sounds: {
            move: { type: 'sine', duration: 0.12, frequency: 880, decay: 0.02 },
            capture: { type: 'square', duration: 0.15, frequency: 440, decay: 0.03 },
            check: { type: 'triangle', duration: 0.4, frequency: 880, sweep: true, sweepTo: 1320 },
            castle: { type: 'sine', duration: 0.2, frequency: 660, decay: 0.01 },
            promotion: { type: 'sine', duration: 0.25, frequency: 1046.5, decay: 0.02 },
            gameStart: { type: 'sine', duration: 0.6, frequency: 523.25, pattern: [0,0.2,0.4] },
            gameEnd: { type: 'sine', duration: 0.8, frequency: 440, pattern: [0,0.3,0.6], fadeOut: true },
            moveError: { type: 'sawtooth', duration: 0.1, frequency: 220, decay: 0.05 }
        },
        // Хранилище буферов (если используются предзаписанные звуки)
        buffers: {}
    };

    // ======================== Web Audio API контекст ========================
    let audioCtx = null;
    let isInitialized = false;
    let masterGain = null;
    let currentSoundSource = null;

    // Инициализация аудиоконтекста (по первому действию пользователя, т.к. браузеры блокируют автовоспроизведение)
    function initAudio() {
        if (audioCtx) return;
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            masterGain = audioCtx.createGain();
            masterGain.gain.value = SoundConfig.enabled ? SoundConfig.volume : 0;
            masterGain.connect(audioCtx.destination);
            isInitialized = true;
            console.log('[Sound] Audio context initialized');
        } catch(e) {
            console.warn('[Sound] Web Audio API not supported', e);
        }
    }

    // Воспроизведение синтезированного звука
    function playSynthesized(soundDef) {
        if (!audioCtx || !SoundConfig.enabled) return;
        const now = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = soundDef.type || 'sine';
        osc.frequency.value = soundDef.frequency || 440;
        gain.gain.setValueAtTime(SoundConfig.volume * 0.5, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + (soundDef.duration || 0.2));
        if (soundDef.sweep) {
            osc.frequency.exponentialRampToValueAtTime(soundDef.sweepTo || soundDef.frequency * 1.5, now + (soundDef.duration || 0.2));
        }
        osc.connect(gain);
        gain.connect(masterGain);
        osc.start();
        osc.stop(now + (soundDef.duration || 0.2));
        // Если есть паттерн (несколько нот)
        if (soundDef.pattern && soundDef.pattern.length) {
            for (let i = 1; i < soundDef.pattern.length; i++) {
                const subOsc = audioCtx.createOscillator();
                const subGain = audioCtx.createGain();
                subOsc.type = soundDef.type;
                subOsc.frequency.value = soundDef.frequency * (1 + i * 0.1);
                subGain.gain.setValueAtTime(SoundConfig.volume * 0.3, now + soundDef.pattern[i]);
                subGain.gain.exponentialRampToValueAtTime(0.0001, now + soundDef.duration);
                subOsc.connect(subGain);
                subGain.connect(masterGain);
                subOsc.start(now + soundDef.pattern[i]);
                subOsc.stop(now + soundDef.duration);
            }
        }
    }

    // Воспроизведение звука по имени события
    function play(eventName) {
        if (!SoundConfig.enabled) return;
        if (!audioCtx) {
            initAudio();
            if (!audioCtx) return;
        }
        // Разрешаем аудиоконтекст, если он suspend (после инициализации)
        if (audioCtx.state === 'suspended') {
            audioCtx.resume().then(() => {
                console.log('[Sound] Audio context resumed');
            }).catch(e => console.warn(e));
        }
        const soundDef = SoundConfig.sounds[eventName];
        if (soundDef) {
            playSynthesized(soundDef);
        } else {
            console.warn(`[Sound] Unknown sound event: ${eventName}`);
        }
    }

    // Установить громкость (0-1)
    function setVolume(vol) {
        SoundConfig.volume = Math.min(1, Math.max(0, vol));
        if (masterGain) masterGain.gain.value = SoundConfig.enabled ? SoundConfig.volume : 0;
    }

    // Включить/выключить звук
    function setEnabled(enabled) {
        SoundConfig.enabled = enabled;
        if (masterGain) masterGain.gain.value = enabled ? SoundConfig.volume : 0;
        if (!enabled && audioCtx && audioCtx.state === 'running') {
            // Не останавливаем контекст, просто приглушаем
        }
    }

    // Проверка поддержки звука
    function isSupported() {
        return !!(window.AudioContext || window.webkitAudioContext);
    }

    // Принудительная инициализация (вызывается по клику пользователя)
    function enable() {
        initAudio();
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        setEnabled(true);
    }

    // ======================== Интеграция с настройками UI ========================
    function syncWithSettings() {
        const settings = window.BurchessSettings;
        if (settings) {
            setEnabled(settings.soundEnabled !== undefined ? settings.soundEnabled : true);
        }
        // Settings.apply() синхронизирует звук при сохранении настроек.
    }

    // Инициализация модуля
    function init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                syncWithSettings();
                // Предварительная инициализация контекста при первом взаимодействии пользователя
                const initAudioOnFirstClick = () => {
                    enable();
                    document.removeEventListener('click', initAudioOnFirstClick);
                    document.removeEventListener('keydown', initAudioOnFirstClick);
                };
                document.addEventListener('click', initAudioOnFirstClick);
                document.addEventListener('keydown', initAudioOnFirstClick);
            });
        } else {
            syncWithSettings();
            document.addEventListener('click', () => enable(), { once: true });
            document.addEventListener('keydown', () => enable(), { once: true });
        }
        console.log('[Sound] Module ready');
    }

    // Публичный API
    window.Sound = {
        play,
        setVolume,
        setEnabled,
        isSupported,
        enable,
        init
    };

    // Автозапуск
    init();
})();
