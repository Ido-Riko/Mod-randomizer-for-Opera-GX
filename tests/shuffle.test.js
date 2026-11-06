import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, A, B, C, clone, flush } from './helpers.js';

const key = name => JSON.stringify(['profile', name]);
const allKey = JSON.stringify(['all']);
function three(options = {}) {
    return environment({
        ...options,
        data: { profiles: { Default: [A, B, C], Other: [A, B, C] }, ...options.data },
        mods: [A, B, C].map((id, i) => ({ id, name: ['Alpha', 'Beta', 'Gamma'][i], enabled: false, updateUrl: 'https://api.gx.me/store/mods/update' }))
    });
}
const draw = async env => (await env.message('getRandomMod'))?.id;

test('default shuffle visits every mod each cycle without boundary repeats', async () => {
    const env = three();
    let previous;
    for (let cycle = 0; cycle < 8; cycle++) {
        const ids = [];
        for (let i = 0; i < 3; i++) {
            const id = await draw(env);
            assert.notEqual(id, previous);
            ids.push(id); previous = id;
        }
        assert.equal(new Set(ids).size, 3);
    }
});
test('bags survive worker restarts and stay independent for profiles and all-mods', async () => {
    let env = three();
    const first = await draw(env);
    env = three({ data: clone(env.data) });
    const second = await draw(env);
    assert.notEqual(second, first);
    const defaultSeen = clone(env.data.shuffleBags[key('Default')]);
    await env.message('setActiveProfile', { profileName: 'Other' });
    await draw(env);
    assert.deepEqual(env.data.shuffleBags[key('Default')], defaultSeen);
    assert.equal(env.data.shuffleBags[key('Other')].length, 1);
    env.data.autoModIdentificationChecked = true;
    env.data.detectedModList = env.mods.map(({ id, name }) => ({ id, name }));
    await draw(env);
    assert.equal(env.data.shuffleBags[allKey].length, 1);
    assert.equal(env.data.shuffleBags[key('Other')].length, 1);
    env.data.autoModIdentificationChecked = false;
    await env.message('setActiveProfile', { profileName: 'Default' });
    const third = await draw(env);
    assert.equal(new Set([first, second, third]).size, 3);
});
test('edits and newly installed mods reconcile with an unfinished bag', async () => {
    const env = three({ data: { profiles: { Default: [A, B] } } });
    assert.equal(await draw(env), A);
    await env.message('saveModExtensionIds', { profileName: 'Default', changes: { [C]: true, [B]: false } });
    assert.equal(await draw(env), C);
    assert.deepEqual(env.data.shuffleBags[key('Default')], [A, C]);
});
for (const useAll of [false, true]) {
    test(`temporarily absent reinstall target retains its draw in ${useAll ? 'all-mods' : 'profile'} mode`, async () => {
        const env = three({ data: { autoModIdentificationChecked: useAll } });
        const identify = () => { env.data.detectedModList = env.mods.map(({ id, name }) => ({ id, name })); };
        identify();
        assert.equal(await draw(env), A);
        const removed = env.mods.shift(); identify();
        assert.equal(await draw(env), C);
        env.mods.unshift(removed); identify();
        assert.equal(await draw(env), B);
        assert.equal(new Set(env.data.shuffleBags[useAll ? allKey : key('Default')]).size, 3);
    });
}
test('failed enables and empty pools consume no draws', async () => {
    const env = three({ failEnable: true });
    assert.equal((await env.message('getRandomMod')).status, 'error');
    assert.equal(env.data.shuffleBags, undefined);
    env.data.profiles.Default = [];
    assert.equal(await env.message('getRandomMod'), null);
    assert.equal(env.data.shuffleBags, undefined);
});
test('toggle off restores ordinary randomness and toggle on starts fresh bags', async () => {
    const env = three();
    await draw(env);
    await env.message('setShuffleBag', { value: false });
    assert.deepEqual(env.data.shuffleBags, {});
    const ids = [await draw(env), await draw(env), await draw(env)];
    assert.equal(new Set(ids).size, 2, 'ordinary random can repeat before all mods are used');
    assert.deepEqual(env.data.shuffleBags, {});
    await env.message('setShuffleBag', { value: true });
    assert.equal(new Set([await draw(env), await draw(env), await draw(env)]).size, 3);
});
test('rename preserves bag progress and delete removes it', async () => {
    const env = three();
    await draw(env);
    await env.message('renameProfile', { oldName: 'Default', newName: 'Renamed' });
    assert.deepEqual(env.data.shuffleBags[key('Renamed')], [A]);
    assert.equal(env.data.shuffleBags[key('Default')], undefined);
    await env.message('deleteProfile', { profileName: 'Renamed' });
    assert.equal(env.data.shuffleBags[key('Renamed')], undefined);
});
test('installation and migration enable shuffle without overriding an opt-out', async () => {
    for (const reason of ['install', 'update']) {
        const env = three();
        await Promise.all(env.chrome.runtime.onInstalled.emit({ reason }));
        assert.equal(env.data.shuffleBagChecked, true);
    }
    const env = three({ data: { shuffleBagChecked: false } });
    await Promise.all(env.chrome.runtime.onInstalled.emit({ reason: 'update' }));
    assert.equal(env.data.shuffleBagChecked, false);
});
test('manual reinstall, URL fallback and automatic reinstall all consume one draw', async () => {
    const env = three({ data: { uninstallAndReinstallChecked: true, toggleRandomizeOnSetTimeChecked: true } });
    assert.equal(await draw(env), A);
    assert.equal(env.data.pendingNotification.modId, A);
    assert.equal(await draw(env), C); // Missing catalog URL uses enable-only fallback.
    assert.equal(env.data.shuffleBags[key('Default')].length, 2);
    env.data.lastRandomizationTime = 0;
    await Promise.all(env.chrome.alarms.onAlarm.emit({ name: 'randomizeAlarm' }));
    assert.equal(env.data.lastEnabledModId, B);
    assert.equal(env.data.shuffleBags[key('Default')].length, 3);
    assert.equal(env.calls.uninstall.length, 0);
});
test('automatic notification path records a draw even though it returns no mod', async () => {
    const env = environment({ data: { profiles: { Default: [A] }, uninstallAndReinstallChecked: true, toggleRandomizeOnStartupChecked: true } });
    await Promise.all(env.chrome.runtime.onStartup.emit());
    await env.runTimers(1000); await flush();
    assert.deepEqual(env.data.shuffleBags[key('Default')], [A]);
    assert.equal(env.data.pendingNotification.modId, A);
});
