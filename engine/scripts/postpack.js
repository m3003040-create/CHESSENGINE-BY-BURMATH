#!/usr/bin/env node

"use strict";

var fs = require("fs");
var p = require("path");

var binDir = p.join(__dirname, "..", "bin");

/// Remove anything there already.
fs.readdirSync(binDir).forEach(function (filename)
{
    fs.unlinkSync(p.join(binDir, filename));
});

fs.rmdirSync(binDir);