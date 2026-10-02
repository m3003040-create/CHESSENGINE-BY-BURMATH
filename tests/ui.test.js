const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { FakeClock } = require('./support/clock');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Only the DOM contract used by this UI is modeled. Element IDs and engine
// choices come from the real HTML so markup and JavaScript are checked together.
function createHarness() {
    class Element {
        constructor(tag = 'div') {
            this.tag = tag; this.value = ''; this.textContent = ''; this.style = {};
            this.attributes = {}; this.listeners = {}; this.options = []; this.children = {};
            const classes = new Set();
            this.classList = {
                contains: name => classes.has(name),
                toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
                add: name => classes.add(name), remove: name => classes.delete(name),
            };
        }
        setAttribute(name, value) { this.attributes[name] = value; }
        removeAttribute(name) { delete this.attributes[name]; }
        getAttribute(name) { return this.attributes[name]; }
        addEventListener(event, callback) { (this.listeners[event] ||= []).push(callback); }
        dispatch(event) { for (const callback of this.listeners[event] || []) callback({ target: this }); }
        appendChild(option) { option.parent = this; this.options.push(option); }
        remove() { this.parent.options = this.parent.options.filter(option => option !== this); }
        querySelector(selector) {
            const value = selector.match(/^option\[value="([^"]+)"\]$/)?.[1];
            return value ? this.options.find(option => option.value === value) || null : this.children[selector] || null;
        }
    }
    const elements = new Map();
    for (const match of html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const element = new Element(match[1]);
        elements.set(match[2], element);
        if (match[1] === 'select') {
            const body = html.slice(match.index + match[0].length).split('</select>')[0];
            for (const option of body.matchAll(/<option\b[^>]*value="([^"]+)"[^>]*>([^<]*)<\/option>/g)) {
                const child = new Element('option');
                child.value = option[1]; child.textContent = option[2];
                element.appendChild(child);
                if (!element.value || option[0].includes('selected')) element.value = child.value;
            }
        }
    }
    elements.get('engine-status').children['.engine-status-text'] = new Element('span');
    const document = {
        documentElement: new Element('html'),
        getElementById: id => elements.get(id) || null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: tag => new Element(tag),
        addEventListener() {},
    };
    const clock = new FakeClock();
    const intervals = new Map();
    let nextInterval = 1;
    function setInterval(callback, delay) {
        const id = nextInterval++;
        function tick() {
            if (!intervals.has(id)) return;
            callback();
            if (intervals.has(id)) intervals.set(id, clock.setTimeout(tick, delay));
        }
        intervals.set(id, clock.setTimeout(tick, delay));
        return id;
    }
    function clearInterval(id) { clock.clearTimeout(intervals.get(id)); intervals.delete(id); }
    const context = {
        window: {}, document, localStorage: { getItem: () => null, setItem() {} },
        setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock),
        setInterval, clearInterval,
        performance: { now: () => clock.now },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'ui.js'), 'utf8'), context,
        { filename: 'ui.js' });
    return { ui: context.window.UI, elements, clock, window: context.window };
}

function provider(connected, state = connected ? 'ready' : 'unavailable') {
    return { connected, ready: connected, state };
}

test('the two indicators update independently and expose only the requested engine names', () => {
    const h = createHarness();
    h.ui.updateProviders({ old: provider(true), new: provider(false) });
    h.ui.init();
    const old = h.elements.get('connection-status-old');
    const current = h.elements.get('connection-status-new');
    assert.equal(old.classList.contains('connected'), true);
    assert.equal(current.classList.contains('connected'), false);
    assert.equal(old.getAttribute('aria-label'), 'Старый движок Марика: подключён');
    assert.equal(current.getAttribute('aria-label'), 'Новый движок Марика: недоступен');
    h.ui.updateProviders({ old: provider(false, 'connecting'), new: provider(true) });
    assert.equal(old.classList.contains('connected'), false);
    assert.equal(old.classList.contains('connecting'), true);
    assert.equal(current.classList.contains('connected'), true);
    assert.equal(current.getAttribute('title'), 'Новый движок Марика: подключён');
    h.ui.setActiveEngine('new');
    h.ui.setEngineStatus(true);
    assert.equal(h.elements.get('engine-status').querySelector('.engine-status-text').textContent,
        'Новый движок Марика активен');
    const visibleText = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<!--[^]*?-->/g, '')
        .replace(/<[^>]+>/g, ' ');
    assert.doesNotMatch(visibleText, /chess-api|wukong/i);
});

test('both connected APIs allow the player to select either named opponent', () => {
    const h = createHarness();
    h.ui.init();
    h.ui.updateProviders({ old: provider(true), new: provider(true) });
    const opponent = h.elements.get('opponent-engine');
    assert.equal(opponent.options.find(option => option.value === 'old').disabled, false);
    assert.equal(opponent.options.find(option => option.value === 'new').disabled, false);
    opponent.value = 'new';
    opponent.dispatch('change');
    let setup;
    h.ui.setCallbacks({ onStartGame: config => { setup = config; } });
    h.elements.get('start-game-btn').dispatch('click');
    assert.equal(setup.mode, 'human');
    assert.equal(setup.opponentEngine, 'new');
});

test('arena controls require both APIs and keep different engines on the two colors', () => {
    const h = createHarness();
    h.ui.init();
    h.ui.updateProviders({ old: provider(true), new: provider(false) });
    const mode = h.elements.get('game-mode');
    mode.value = 'arena'; mode.dispatch('change');
    assert.equal(h.elements.get('start-game-btn').disabled, true);
    h.ui.updateProviders({ old: provider(true), new: provider(true) });
    assert.equal(h.elements.get('start-game-btn').disabled, false);
    const white = h.elements.get('white-engine');
    white.value = 'new'; white.dispatch('change');
    assert.equal(h.elements.get('black-engine').value, 'old');
    let setup;
    h.ui.setCallbacks({ onStartGame: config => { setup = config; } });
    h.elements.get('start-game-btn').dispatch('click');
    assert.equal(setup.whiteEngine, 'new');
    assert.equal(setup.blackEngine, 'old');
    h.ui.setGameMode('arena', true);
    assert.equal(h.elements.get('undo-btn').disabled, true);
    assert.equal(h.elements.get('hint-btn').disabled, true);
    assert.equal(h.elements.get('arena-pause-btn').hidden, false);
    assert.match(h.elements.get('arena-pause-btn').textContent, /Продолжить/);
    h.ui.updateProviders({ old: provider(false), new: provider(true) });
    assert.equal(h.elements.get('arena-pause-btn').disabled, false,
        'resume remains available to retry the failed connection');
});

test('both failed APIs automatically expose the original local opponent', () => {
    const h = createHarness();
    h.ui.init();
    h.ui.updateProviders({ old: provider(false), new: provider(false) });
    const opponent = h.elements.get('opponent-engine');
    assert.equal(opponent.value, 'local');
    assert.equal(opponent.querySelector('option[value="local"]').textContent, 'Резервный движок');
    h.ui.updateProviders({ old: provider(false), new: provider(true) });
    assert.equal(opponent.value, 'new');
    assert.equal(opponent.querySelector('option[value="local"]'), null);
});

test('arena timer pause and resume preserve the elapsed time', () => {
    const h = createHarness();
    h.ui.init();
    h.ui.startTimers();
    h.clock.tick(3000);
    assert.equal(h.ui.getWhiteTime(), 897);
    h.ui.pauseTimers();
    h.clock.tick(5000);
    assert.equal(h.ui.getWhiteTime(), 897);
    h.ui.resumeTimers();
    h.clock.tick(1000);
    assert.equal(h.ui.getWhiteTime(), 896);
});

test('timer expiry informs the game once and stops both clocks', () => {
    const h = createHarness();
    h.ui.init();
    h.window.BurchessSettings.gameTime = 2 / 60;
    const expired = [];
    h.ui.setCallbacks({ onTimeOut: color => expired.push(color) });
    h.ui.startTimers();
    h.clock.tick(10000);
    assert.deepEqual(expired, ['white']);
    assert.equal(h.ui.getWhiteTime(), 0);
    assert.equal(h.ui.getBlackTime(), 2);
    h.ui.resumeTimers();
    h.clock.tick(10000);
    assert.deepEqual(expired, ['white']);
});

test('rapid arena turns debit both clocks and retain fractions between moves', () => {
    const h = createHarness();
    h.ui.init();
    h.ui.setGameMode('arena', false);
    h.ui.startTimers();
    for (let turn = 0; turn < 10; turn++) {
        h.clock.tick(400);
        h.ui.updateTurnDisplay('black');
        h.clock.tick(600);
        h.ui.updateTurnDisplay('white');
    }
    assert.ok(Math.abs(h.ui.getWhiteTime() - 896) < 1e-9);
    assert.ok(Math.abs(h.ui.getBlackTime() - 894) < 1e-9);
    assert.equal(h.elements.get('white-timer').textContent, '14:56');
    assert.equal(h.elements.get('black-timer').textContent, '14:54');
});

test('two rapid moves and a pause preserve fractional time without charging the paused interval', () => {
    const h = createHarness();
    h.ui.init();
    h.ui.setGameMode('arena', false);
    h.ui.startTimers();
    h.clock.tick(450);
    h.ui.updateTurnDisplay('black');
    h.clock.tick(650);
    h.ui.updateTurnDisplay('white');
    assert.ok(Math.abs(h.ui.getWhiteTime() - 899.55) < 1e-9);
    assert.ok(Math.abs(h.ui.getBlackTime() - 899.35) < 1e-9);
    h.clock.tick(350);
    h.ui.pauseTimers();
    h.clock.tick(5000);
    assert.ok(Math.abs(h.ui.getWhiteTime() - 899.2) < 1e-9);
    assert.ok(Math.abs(h.ui.getBlackTime() - 899.35) < 1e-9);
    h.ui.resumeTimers();
    h.clock.tick(700);
    h.ui.pauseTimers();
    assert.ok(Math.abs(h.ui.getWhiteTime() - 898.5) < 1e-9);
    assert.ok(Math.abs(h.ui.getBlackTime() - 899.35) < 1e-9);
    assert.equal(h.elements.get('white-timer').textContent, '14:59');
    assert.equal(h.elements.get('black-timer').textContent, '15:00');
});
