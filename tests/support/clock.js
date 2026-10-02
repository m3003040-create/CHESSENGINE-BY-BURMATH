'use strict';

class FakeClock {
    constructor() {
        this.now = 0;
        this.nextId = 1;
        this.timers = new Map();
    }

    setTimeout(callback, delay = 0, ...args) {
        const id = this.nextId++;
        this.timers.set(id, { at: this.now + Math.max(0, delay), callback, args });
        return id;
    }

    clearTimeout(id) { this.timers.delete(id); }

    tick(milliseconds) {
        const target = this.now + milliseconds;
        for (;;) {
            const pending = [...this.timers.entries()]
                .filter(([, timer]) => timer.at <= target)
                .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
            if (!pending) break;
            const [id, timer] = pending;
            this.now = timer.at;
            this.timers.delete(id);
            timer.callback(...timer.args);
        }
        this.now = target;
    }
}

module.exports = { FakeClock };
