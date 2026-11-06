import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { environment, evaluate, element, flush, A, B, mod } from './helpers.js';
import { uninstallFromGesture, validReinstallMod, notificationIdFor, modFromNotificationId } from '../modules/reinstall.js';

function uiEnvironment(sidebar = false) {
    let gesture = false;
    const env = environment({ data: { uninstallAndReinstallChecked: true }, requireGesture: true, gesture: () => gesture });
    const names = ['profileSelect','newProfileBtn','deleteProfileBtn','autoModToggle','disableOutsideProfileToggle','openModsToggle','openModsTabToggle','showNotificationsToggle','startupToggle','setTimeToggle','timeInput','timeUnit','randomizeButton','extensionList','searchBar','currentMod','message','toggleAllBtn','reverseAllBtn'];
    const els = Object.fromEntries(names.map(name => [name, element()]));
    const dom = new Map(); let ready, reinstallClick, closed = false;
    const timers = new Map(); let timer = 0;
    const messages = [], errors = [];
    const context = vm.createContext({
        chrome: env.chrome, console: { log() {}, error() {} }, uninstallFromGesture,
        window: { location: { pathname: sidebar ? '/sidebar.html' : '/popup.html' }, close() { closed = true; } },
        document: { addEventListener(name, fn) { if (name === 'DOMContentLoaded') ready = fn; }, getElementById(id) { if (!dom.has(id)) dom.set(id, element()); return dom.get(id); } },
        initEls: () => els, getEls: () => els, port: { onMessage: { addListener() {} } },
        storageGet: keys => env.chrome.storage.local.get(keys),
        storageSet: value => new Promise(resolve => env.chrome.storage.local.set(value, resolve)),
        sendMsg: async (action, fields) => { messages.push({ action, ...fields }); const result = await env.message(action, fields); if (result?.status === 'error') throw new Error(result.message); return result; },
        showModMessage() {}, clearEnabledMessage() {}, showRedirectMessage() {}, removeRedirectMessage() {},
        showMissedNotificationMessage(target, callback) { reinstallClick = callback; },
        showError: message => errors.push(message), customAlert: async message => errors.push(message),
        renderExtensionList: async () => {}, loadAndRenderProfiles: async () => {}, getRenderLock: () => false,
        getCurrentProfile: () => env.data.activeProfile, setCurrentProfile() {}, exportProfiles() {}, importProfiles() {}, showImportResults() {},
        toMinutes: (value, unit) => value * ({ minutes: 1, hours: 60, days: 1440 }[unit]), fromMinutesFormat: String,
        setTimeout(fn, delay) { timers.set(++timer, { fn, delay }); return timer; }, clearTimeout: id => timers.delete(id)
    });
    evaluate('popup.js', context); ready();
    return { ...env, els, context, messages, errors, timers, get closed() { return closed; },
        async randomize() { await els.randomizeButton.listeners.click(); },
        clickReinstall() { gesture = true; reinstallClick(); gesture = false; }
    };
}
for (const sidebar of [false, true]) {
    test(`${sidebar ? 'sidebar' : 'popup'} offers reinstall and invokes uninstall synchronously on explicit click`, async () => {
        const ui = uiEnvironment(sidebar); await flush(); await ui.randomize();
        assert.equal(ui.calls.uninstall.length, 0, 'preparation must not uninstall');
        ui.clickReinstall(); assert.equal(ui.calls.uninstall.length, 1);
        assert.equal(ui.calls.uninstall[0].config.showConfirmDialog, true);
        assert.equal(ui.calls.tabs.length, 0, 'store tab must wait for confirmation');
        ui.calls.uninstall[0].cb(); await flush();
        assert.equal(ui.calls.tabs[0].url, mod.reinstallUrl);
        assert.equal(ui.closed, !sidebar);
        assert.equal(ui.data.pendingNotification, undefined);
    });
    test(`${sidebar ? 'sidebar' : 'popup'} cancellation keeps retry action and opens no tab`, async () => {
        const ui = uiEnvironment(sidebar); await flush(); await ui.randomize(); ui.clickReinstall();
        ui.chrome.runtime.lastError = { message: 'User cancelled' }; ui.calls.uninstall[0].cb(); delete ui.chrome.runtime.lastError;
        assert.equal(ui.calls.tabs.length, 0); assert.equal(ui.closed, false);
        assert.equal(ui.data.pendingNotification.modId, A); assert.match(ui.errors.at(-1), /cancelled/);
        ui.clickReinstall(); assert.equal(ui.calls.uninstall.length, 2);
        ui.calls.uninstall[1].cb(); await flush();
    });
}
test('timer 5 -> 0 -> 5 saves the restored interval', async () => {
    const ui = uiEnvironment(); await flush(); ui.els.timeUnit.value = 'minutes';
    for (const value of ['5', '0', '5']) {
        ui.els.timeInput.value = value;
        await ui.els.timeInput.listeners.input({ target: ui.els.timeInput });
        for (const [id, timer] of [...ui.timers]) if (timer.delay === 400) { ui.timers.delete(id); await timer.fn(); }
    }
    assert.deepEqual(ui.messages.filter(m => m.action === 'setRandomizeTime').map(m => m.time), [5, 0, 5]);
    assert.equal(ui.data.randomizeTime, 5);
});
test('Cancel in profile prompt returns null; OK returns entered text', async () => {
    const elements = Object.fromEntries(['modalOverlay','modalTitle','modalMessage','modalInput','modalButtons'].map(id => [id, element()]));
    const context = vm.createContext({ document: { getElementById: id => elements[id], createElement: element }, setTimeout() {} });
    evaluate('modules/utils.js', context);
    const cancelled = context.customPrompt('Name', 'Old'); elements.modalInput.value = 'New'; elements.modalButtons.children[0].click(); assert.equal(await cancelled, null);
    const accepted = context.customPrompt('Name', 'Old'); elements.modalInput.value = 'New'; elements.modalButtons.children[1].click(); assert.equal(await accepted, 'New');
});
test('export retains Default and colliding exported names', async () => {
    let exported;
    const context = vm.createContext({
        console: { log() {}, error() {} }, customAlert: async () => {},
        storageGet: async () => ({ profiles: { Default: [A], 'Default (Exported)': [B], 'Default (Exported 2)': [] }, detectedModList: [] }),
        Blob: class { constructor(parts) { exported = JSON.parse(parts[0]); } },
        URL: { createObjectURL() { return 'blob:test'; }, revokeObjectURL() {} },
        document: { createElement: element, body: element() }
    });
    evaluate('modules/profiles.js', context); await context.exportProfiles();
    assert.equal(Object.keys(exported.profiles).length, 3);
    assert.equal(exported.profiles['Default (Exported 3)'][0].id, A);
    assert.equal(exported.profiles['Default (Exported)'][0].id, B);
});
test('profile dropdown follows externally selected profile', async () => {
    let activeProfile = 'Default'; const select = element();
    const context = vm.createContext({
        storageGet: async () => ({ profiles: { Default: [A], Other: [B] }, activeProfile }),
        sendMsg: async () => ({}), getEls: () => ({ profileSelect: select }), document: { createElement: element }
    });
    evaluate('modules/profiles.js', context); await context.loadAndRenderProfiles();
    activeProfile = 'Other'; await context.loadAndRenderProfiles(); assert.equal(select.value, 'Other');
});
test('reinstall payload validates IDs and store URLs', () => {
    assert.equal(validReinstallMod(mod), true);
    assert.deepEqual(modFromNotificationId(notificationIdFor(mod)), mod);
    assert.equal(validReinstallMod({ ...mod, reinstallUrl: 'https://evil.example/mods/foo' }), false);
    assert.equal(modFromNotificationId('modRandomizerReinstall:malformed'), null);
});
test('double click does not issue two uninstall requests', () => {
    const env = environment();
    uninstallFromGesture(mod, () => {}, env.chrome); uninstallFromGesture(mod, () => {}, env.chrome);
    assert.equal(env.calls.uninstall.length, 1); env.calls.uninstall[0].cb();
});
test('real checkbox saver sends deltas immediately and reconciles rapid edits', async () => {
    const env = environment(), elements = new Map();
    const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
    const list = get('extensionList'); list.parentElement = element();
    list.querySelectorAll = () => list.children.flatMap(li => li.children).filter(child => child.type === 'checkbox');
    const messages = [];
    const context = vm.createContext({
        document: { getElementById: get, createElement: element, querySelector: () => element() },
        storageGet: keys => env.chrome.storage.local.get(keys),
        sendMsg: async (action, fields) => { messages.push({ action, ...fields }); return env.message(action, fields); },
        setTimeout() {}, clearTimeout() {}, console: { log() {} }
    });
    evaluate('modules/ui.js', context); context.initEls(); await context.renderExtensionList();
    const boxes = list.querySelectorAll(); boxes[0].checked = false;
    const first = boxes[0].listeners.change(); boxes[1].checked = false;
    const second = boxes[1].listeners.change(); await Promise.all([first, second]);
    assert.deepEqual(env.data.profiles.Default, []);
    assert.deepEqual(messages.filter(m => m.action === 'saveModExtensionIds').map(m => Object.keys(m.changes)), [[A], [B]]);
    assert.equal(context.getRenderLock(), false);
    assert.equal(list.querySelectorAll().every(cb => !cb.checked), true);
});
