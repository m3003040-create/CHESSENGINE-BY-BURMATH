"use strict";

var fs = require("fs");
var p = require("path");

var node_modules = p.join(__dirname, "node_modules");
var basedir = p.join(node_modules, "stockfish", "bin");

function hasEngines()
{
    return fs.existsSync(p.join(basedir, "stockfish.js")) && fs.existsSync(p.join(basedir, "stockfish.wasm"));
}

if (!hasEngines()) {
    try {
        fs.mkdirSync(node_modules);
    } catch (e) {}
    require("child_process").execFileSync("npm", ["i"], {cwd: __dirname});
    if (!hasEngines()) {
        console.error("Could not find stockfish engine. Please run \"npm install\" first.");
        process.exit(1);
    }
}
