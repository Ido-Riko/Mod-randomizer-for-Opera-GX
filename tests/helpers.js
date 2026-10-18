import fs from 'node:fs';
import vm from 'node:vm';
import * as reinstall from '../modules/reinstall.js';
export const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32);
export const mod = { id: A, name: 'Alpha', reinstallUrl: 'https://store.gx.me/mods/alpha/example/' };
export const clone = value => structuredClone(value);
export const source = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
export function evaluate(file, context) {
    vm.runInContext(source(file).replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, ''), context, { filename: file });
}
export function event() {
    return { listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { return this.listeners.map(fn => fn(...args)); } };
}
export const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
export function environment(options = {}) {
    const data = {
        profiles: { Default: [A, B] }, profilesOrder: { Default: [A, B] }, activeProfile: 'Default',
        knownDetectedIds: [A, B], detectedModList: [{ id: A, name: 'Alpha' }, { id: B, name: 'Beta' }],
        autoModIdentificationChecked: false, uninstallAndReinstallChecked: false,
        openModsTabChecked: false, showNotificationsChecked: true,
        ...clone(options.data || {})
    };
    const mods = clone(options.mods || [
        { id: A, name: 'Alpha', enabled: false, updateUrl: 'https://api.gx.me/store/mods/update' },
        { id: B, name: 'Beta', enabled: false, updateUrl: 'https://api.gx.me/store/mods/update' }
    ]);
    const calls = { tabs: [], uninstall: [], enabled: [], fetch: [], notifications: [], alarms: [] };
    const timers = new Map(); let timerId = 0;
    const setTimeout = (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; };
    const runtime = { onConnect: event(), onMessage: event(), onStartup: event(), onInstalled: event(), getURL: file => 'chrome-extension://test/' + file };
    const chrome = {
        runtime,
        storage: { onChanged: event(), local: {
            get(keys, cb) {
                const value = Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in data).map(k => [k, clone(data[k])]));
                if (cb) queueMicrotask(() => cb(value)); else return Promise.resolve(value);
            },
            set(value, cb) {
                const changes = {};
                for (const [key, next] of Object.entries(value)) {
                    if (JSON.stringify(data[key]) !== JSON.stringify(next)) changes[key] = { oldValue: data[key], newValue: clone(next) };
                    data[key] = clone(next);
                }
                queueMicrotask(() => { cb?.(); if (Object.keys(changes).length) chrome.storage.onChanged.emit(changes, 'local'); });
            },
            remove(keys, cb) {
                const changes = {};
                for (const key of [keys].flat()) { if (key in data) changes[key] = { oldValue: data[key] }; delete data[key]; }
                queueMicrotask(() => { cb?.(); if (Object.keys(changes).length) chrome.storage.onChanged.emit(changes, 'local'); });
            }
        } },
        management: {
            getAll(cb) { const snapshot = clone(mods); queueMicrotask(() => cb(snapshot)); },
            setEnabled(id, enabled, cb) {
                calls.enabled.push({ id, enabled });
                queueMicrotask(() => {
                    if (options.failEnable) runtime.lastError = { message: 'Permission denied' };
                    else mods.find(mod => mod.id === id).enabled = enabled;
                    cb(); delete runtime.lastError;
                });
            },
            uninstall(id, config, cb) {
                calls.uninstall.push({ id, config, cb });
                if (options.requireGesture && !options.gesture?.()) throw new Error('User gesture required');
            },
            onInstalled: event(), onUninstalled: event()
        },
        tabs: { create(config) { calls.tabs.push(config); } },
        notifications: { onClicked: event(), onClosed: event(), clear() {}, create(id, config) { calls.notifications.push({ id, config }); } },
        alarms: { onAlarm: event(), clear(id, cb) { calls.alarms.push({ clear: id }); queueMicrotask(() => cb?.(true)); }, create(id, config) { calls.alarms.push({ id, config }); } }
    };
    let random = 0;
    const math = Object.create(Math); math.random = () => random++ % 2 ? .99 : 0;
    const context = vm.createContext({
        chrome, console: { log() {}, warn() {}, error() {}, debug() {} }, Math: math, Date, URL, AbortController,
        setTimeout, clearTimeout: id => timers.delete(id), ...reinstall,
        fetch: async (url, config) => {
            calls.fetch.push(url);
            if (options.fetch) return options.fetch(url, config);
            return { ok: true, json: async () => ({ Alpha: { url: mod.reinstallUrl } }) };
        }
    });
    evaluate('background.js', context);
    function message(action, fields = {}) { return new Promise(resolve => runtime.onMessage.listeners[0]({ action, ...fields }, {}, resolve)); }
    async function runTimers(delay) {
        for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.fn(); }
        await flush();
    }
    return { data, mods, calls, chrome, context, message, timers, runTimers };
}

export function element() {
    const classes = new Set();
    return {
        children: [], listeners: {}, style: {}, dataset: {}, value: '', checked: false,
        classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle(c, yes) { if (yes) classes.add(c); else classes.delete(c); } },
        appendChild(child) { this.children.push(child); }, removeChild(child) { this.children = this.children.filter(c => c !== child); },
        addEventListener(name, fn) { this.listeners[name] = fn; }, removeEventListener() {},
        focus() {}, select() {}, click() { this.onclick?.(); },
        querySelector() { return this.children.find(c => c.className?.includes('primary')); },
        querySelectorAll() { return []; },
        set innerHTML(value) { this.children = []; }, get innerHTML() { return ''; }
    };
}
