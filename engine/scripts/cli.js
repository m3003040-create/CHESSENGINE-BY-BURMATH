#!/usr/bin/env node

var execFileSync = require("child_process").execFileSync;
var fs = require("fs");
var p = require("path");

function runEngine(relPath)
{
    var fullPath = p.join(__dirname, relPath);
    if (!fs.existsSync(fullPath)) {
        return false;
    }
    try {
        execFileSync(process.execPath, [fullPath], {stdio: "inherit"});
    } catch (e) {
        return false;
    }
    return true;
}

if (!runEngine("../bin/stockfish.js")) {
    if (!runEngine("../src/stockfish.js")) {
        console.error("Could not find stockfish.js");
        process.exit(1);
    }
}
