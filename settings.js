(function(){
    var DEFAULTS = {
        playerColor: 'white',
        gameTime: 15,
        soundEnabled: true,
        showCoordinates: true,
        theme: 'light',
        gameMode: 'human',
        opponentEngine: 'old',
        whiteEngine: 'old',
        blackEngine: 'new'
    };

    var current = {};
    for (var k in DEFAULTS) current[k] = DEFAULTS[k];

    function load() {
        try {
            var stored = localStorage.getItem('burchess_settings');
            if (stored) {
                var parsed = JSON.parse(stored);
                current = {};
                for (var k in DEFAULTS) current[k] = DEFAULTS[k];
                for (var k in parsed) {
                    if (DEFAULTS.hasOwnProperty(k)) current[k] = parsed[k];
                }
            } else {
                current = {};
                for (var k in DEFAULTS) current[k] = DEFAULTS[k];
            }
        } catch(e) {
            current = {};
            for (var k in DEFAULTS) current[k] = DEFAULTS[k];
        }
        apply();
        return current;
    }

    function save() {
        try {
            localStorage.setItem('burchess_settings', JSON.stringify(current));
        } catch(e) {}
        apply();
    }

    function apply() {
        document.documentElement.setAttribute('data-theme', current.theme || 'light');
        if (window.Sound && current.soundEnabled !== undefined) window.Sound.setEnabled(current.soundEnabled);
    }

    function get(key) { return current[key]; }
    function set(key, value) { current[key] = value; save(); }
    function reset() {
        current = {};
        for (var k in DEFAULTS) current[k] = DEFAULTS[k];
        save();
    }

    window.Settings = { load: load, save: save, get: get, set: set, reset: reset, DEFAULTS: DEFAULTS };
    window.Settings.load();
})();
