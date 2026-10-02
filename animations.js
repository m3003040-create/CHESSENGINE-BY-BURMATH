/**
 * animations.js — заглушка модуля анимаций
 * Анимации перемещения фигур теперь обрабатываются библиотекой chessboard.js
 */
(function() {
    'use strict';

    window.Animations = {
        init: function() {},
        animateMove: function(fromFile, fromRank, toFile, toRank, piece, onComplete) {
            if (onComplete) onComplete();
        },
        animateCapture: function() {},
        animatePromotion: function() {},
        animateHighlight: function() {},
        clearQueue: function() {},
        stopAll: function() {},
        setEnabled: function() {},
        setQueueEnabled: function() {},
        setDuration: function() {}
    };
})();
