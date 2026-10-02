#!/usr/bin/env node

"use strict";

var fs = require("fs");
var p = require("path");

var version = require("../package.json").version;

var binDir = p.join(__dirname, "..", "bin");
var jsLinkPath = p.join(binDir, "stockfish.js");
var wasmLinkPath = p.join(binDir, "stockfish.wasm");

/// Build candidate list: full, major.minor, major-only
var parts = version.split(".");
var candidates = [
    "stockfish-" + version,
    "stockfish-" + parts.slice(0, 2).join("."),
    "stockfish-" + parts[0],
];

/// Find existing files
var jsFile = "";
var wasmFile = "";
for (var i = 0; i < candidates.length; i++) {
    var candidate = candidates[i];
    var fullBasePath = p.join(binDir, candidate);
    if (fs.existsSync(fullBasePath + ".js") && fs.existsSync(fullBasePath + ".wasm")) {
        jsFile = fullBasePath + ".js";
        wasmFile = fullBasePath + ".wasm";
        break;
    }
}

if (!jsFile) {
    console.error("Error: No candidate file found among:");
    for (i = 0; i < candidates.length; i++) {
        console.error("    - " + candidates[i]);
    }
    process.exit(1);
}

/// Remove existing target (file or symlink) if present
try {
    fs.unlinkSync(jsLinkPath);
} catch (e) {}
try {
    fs.unlinkSync(wasmLinkPath);
} catch (e) {}

/// Try symlink first (most efficient)
try {
    var relSource = p.relative(binDir, jsFile);
    fs.symlinkSync(relSource, jsLinkPath, "file");
    var relWASM = p.relative(binDir, wasmFile);
    fs.symlinkSync(wasmFile, wasmLinkPath, "file");
} catch (err) {
    /// Fallback to copy if symlink fails
    if (process.platform === "win32" && err.code === "EPERM") {
        console.warn("Warning: Symlink creation failed on Windows.\nThis can happen if Developer Mode is not enabled.\nTo enable: Settings > Update & Security > For developers > Developer Mode.\nFalling back to copy...");
    } else {
        console.log("Symlink failed (" + err.message + "). Falling back to copy...");
    }

    fs.copyFileSync(jsFile, jsLinkPath);
    fs.copyFileSync(wasmFile, wasmLinkPath);
}
