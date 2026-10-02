#!/usr/bin/env node

"use strict";

var fs = require("fs");
var p = require("path");

var srcDir = p.join(__dirname, "..", "src");
var binDir = p.join(__dirname, "..", "bin");

try {
    fs.mkdirSync(binDir)
} catch (e) {}

/// Remove anything there already.
fs.readdirSync(binDir).forEach(function (filename)
{
    fs.unlinkSync(p.join(binDir, filename));
});

fs.readdirSync(srcDir).forEach(function (filename)
{
    if (/^stockfish.*\.(?:js|wasm)$/.test(filename)) {
        fs.cpSync(p.join(srcDir, filename), p.join(binDir, filename));
    }
});
