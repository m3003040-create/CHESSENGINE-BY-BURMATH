# Engine source provenance

`wukong.js` is an unchanged copy of the JavaScript Engine API by Code Monkey King (Maksim Korzh).

- Repository: https://github.com/maksimKorzh/wukongJS
- Source revision: `dfc687d585a02e08fbe9c92d2c30b70da00c766d`
- Source file: https://github.com/maksimKorzh/wukongJS/blob/dfc687d585a02e08fbe9c92d2c30b70da00c766d/wukong.js
- Public API documentation: https://github.com/maksimKorzh/wukongJS/blob/dfc687d585a02e08fbe9c92d2c30b70da00c766d/docs/API.MD

The upstream tree at this revision has no explicit LICENSE, COPYING, or NOTICE file. The original author attribution in the source is preserved; no license has been added or inferred.

`wukong-worker.js` is this application's adapter. It uses the documented public Engine API in a browser Worker with a bounded search time. The API is a local JavaScript library, not a hosted REST service. Provider readiness means that the Worker successfully loaded and initialized the real engine.
