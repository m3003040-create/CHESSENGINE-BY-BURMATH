#!/usr/bin/env node

/// Make sure the engine is present.
require("./get-engine.js");

var loadEngine = require("./loadEngine.js");
var engine = loadEngine(require("path").join(__dirname, "node_modules", "stockfish", "bin", "stockfish.js"));

engine.send("go infinite", function onDone(data)
{
    console.log("DONE:", data);
    engine.quit();
}, function onStream(data)
{
    console.log("STREAMING:", data);
});

setTimeout(function ()
{
    engine.send("stop");
}, 1000);
