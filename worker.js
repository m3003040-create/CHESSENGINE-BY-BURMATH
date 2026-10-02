/**
 * worker.js — Web Worker для Stockfish
 * Загружает Stockfish.js (JavaScript-порт движка Stockfish) из CDN
 * и проксирует UCI-команды между основным потоком и движком.
 */
importScripts('https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js');
