import { port, storageGet, storageSet, sendMsg } from './modules/api.js';
import {
    showModal, customAlert, customConfirm, customConfirmDanger, customPrompt,
    toMinutes, fromMinutesFormat
} from './modules/utils.js';
import {
    initEls, getEls, renderExtensionList, triggerManualSave,
    showModMessage, clearEnabledMessage, showRedirectMessage, removeRedirectMessage,
    showError, showImportResults, getRenderLock
} from './modules/ui.js';
import {
    loadAndRenderProfiles, exportProfiles, importProfiles,
    getCurrentProfile, setCurrentProfile
} from './modules/profiles.js';

const isSidebar = window.location.pathname.includes('sidebar.html');

document.addEventListener('DOMContentLoaded', () => {
    // 1. Initialize Elements
    const els = initEls();

    // 2. Listen for messages from background (Port)
    port.onMessage.addListener(async (msg) => {
        if (!msg || !msg.action) return;

        if (msg.action === 'randomizationCompleted' && msg.enabledExtension) {
            await showModMessage(msg.enabledExtension, false);
            refreshCurrentMod();
            console.log('Popup received randomizationCompleted via port');
            if (msg.pendingId) {
                port.postMessage({ action: 'randomizationAck', pendingId: msg.pendingId });
            }
        }

        if (msg.action === 'extensionsUpdated') {
            console.log('Received extensionsUpdated from background');
            await renderExtensionList();
            await refreshCurrentMod();
        }
    });

    // 3. UI Helper: Refresh Active Mod Text
    async function refreshCurrentMod() {
        const s = await storageGet('currentMod');
        const name = s.currentMod || 'None';
        if (els.currentMod) els.currentMod.textContent = `Active Mod: ${name}`;
    }

    // 4. Initialization Logic
    (async function init() {
        document.getElementById('modForm')?.addEventListener('submit', e => e.preventDefault());

        clearEnabledMessage();
        removeRedirectMessage();

        // Defaults
        const sInitial = await storageGet('autoModIdentificationChecked');
        if (sInitial.autoModIdentificationChecked === undefined) {
            await storageSet({ autoModIdentificationChecked: false });
            if (els.autoModToggle) els.autoModToggle.checked = false;
        }

        // Notify background
        await sendMsg('popupOpened');

        // This function from original logic cleaned up unknown IDs
        await cleanupUndetectedMods();

        // Load Toggles & Inputs
        const s = await storageGet([
            'autoModIdentificationChecked', 'uninstallAndReinstallChecked',
            'openModsTabChecked', 'showNotificationsChecked',
            'toggleRandomizeOnStartupChecked', 'toggleRandomizeOnSetTimeChecked',
            'randomizeTime', 'timeUnit', 'currentMod'
        ]);

        const randomizeAll = s.autoModIdentificationChecked === undefined ? false : !!s.autoModIdentificationChecked;
        if (els.autoModToggle) els.autoModToggle.checked = randomizeAll;
        if (els.openModsToggle) els.openModsToggle.checked = s.uninstallAndReinstallChecked === undefined ? true : !!s.uninstallAndReinstallChecked;
        if (els.openModsTabToggle) els.openModsTabToggle.checked = s.openModsTabChecked === undefined ? true : !!s.openModsTabChecked;
        if (els.showNotificationsToggle) els.showNotificationsToggle.checked = s.showNotificationsChecked === undefined ? true : !!s.showNotificationsChecked;
        if (els.startupToggle) els.startupToggle.checked = !!s.toggleRandomizeOnStartupChecked;
        if (els.setTimeToggle) els.setTimeToggle.checked = !!s.toggleRandomizeOnSetTimeChecked;

        const unit = s.timeUnit || 'minutes';
        if (els.timeUnit) {
            els.timeUnit.value = unit;
            els.timeUnit.dataset.previousUnit = unit;
        }
        if (els.timeInput) {
            els.timeInput.value = (s.randomizeTime === 0)
                ? ''
                : ((s.randomizeTime || s.randomizeTime === 0) ? fromMinutesFormat(s.randomizeTime, unit) : '');
        }

        await loadAndRenderProfiles();
        await renderExtensionList();
        await refreshCurrentMod();

        port.postMessage({ action: 'popupReady' });
        console.log('Popup initialized, sent popupReady via port');
    })();

    // 5. Cleanup Logic
    async function cleanupUndetectedMods() {
        const resp = await sendMsg('getExtensions');
        const detected = resp?.detectedModList || [];
        const detectedIds = new Set(detected.map(d => d.id));

        const st = await storageGet(['profilesOrder', 'profiles', 'knownDetectedIds']);
        let changed = false;

        // Only run if we detect a mismatch
        const detectedCount = detected.length;
        const storedCount = (st.knownDetectedIds || []).length;
        if (detectedCount === storedCount) {
            // Optimization: simplistic check
            // In real rigorous check we'd compare content, but this is fine as per original logic
        }

        // Clean profilesOrder
        const profilesOrder = st.profilesOrder || {};
        for (const profileName of Object.keys(profilesOrder)) {
            const before = profilesOrder[profileName].length;
            profilesOrder[profileName] = profilesOrder[profileName].filter(id => detectedIds.has(id));
            if (profilesOrder[profileName].length !== before) changed = true;
        }

        // Clean profiles
        const profiles = st.profiles || {};
        for (const profileName of Object.keys(profiles)) {
            const before = profiles[profileName].length;
            profiles[profileName] = profiles[profileName].filter(id => detectedIds.has(id));
            if (profiles[profileName].length !== before) changed = true;
        }

        // Clean knownDetectedIds
        const knownIds = (st.knownDetectedIds || []).filter(id => detectedIds.has(id));

        if (changed || knownIds.length !== (st.knownDetectedIds || []).length) {
            await storageSet({ profilesOrder, profiles, knownDetectedIds: knownIds });
            console.log('Cleaned up undetected mod IDs from storage');
        }
    }

    // 6. Event Handlers

    // Profile Change
    els.profileSelect.addEventListener('change', async (e) => {
        const profileName = e.target.value;
        if (getRenderLock()) return;

        // Cancel pending manual save if switching
        // Ideally we'd implement clearDebounce in ui.js but simplicity here:
        // switch happens, rendering will assume new profile

        setCurrentProfile(profileName);
        await sendMsg('setActiveProfile', { profileName });
        console.log('Profile switched to', profileName);
        await renderExtensionList(profileName);
    });

    // New Profile
    els.newProfileBtn.addEventListener('click', async () => {
        const nameRaw = await customPrompt('Enter profile name:', '', 'New Profile');
        const name = (nameRaw || '').trim();
        if (!name) return;

        const resp = await sendMsg('getExtensions');
        const profiles = resp?.profiles || {};
        if (Object.keys(profiles).some(n => n.toLowerCase() === name.toLowerCase())) {
            await customAlert('A profile with this name already exists.');
            return;
        }

        const r = await sendMsg('createProfile', { profileName: name });
        if (r && r.status === 'success') {
            await sendMsg('setActiveProfile', { profileName: name });
            setCurrentProfile(name);

            // Just reload all profiles to be safe
            await loadAndRenderProfiles();
            await renderExtensionList();
        } else {
            await customAlert(r && r.message ? r.message : 'Failed to create profile');
        }
    });

    // Delete Profile
    els.deleteProfileBtn.addEventListener('click', async () => {
        const profileName = els.profileSelect.value;
        const confirmed = await customConfirmDanger(
            `Delete profile "${profileName}"? This cannot be undone.`,
            'Delete Profile'
        );
        if (!confirmed) return;

        const r = await sendMsg('deleteProfile', { profileName });
        if (r && r.status === 'success') {
            // remove from profilesOrder
            const st = await storageGet('profilesOrder');
            const po = st.profilesOrder || {};
            if (po[profileName]) { delete po[profileName]; await storageSet({ profilesOrder: po }); }

            await loadAndRenderProfiles();
            await renderExtensionList();
        } else {
            await customAlert(r && r.message ? r.message : 'Delete failed');
        }
    });

    // Import/Export
    const exportProfileBtn = document.getElementById('exportProfileBtn');
    if (exportProfileBtn) exportProfileBtn.addEventListener('click', exportProfiles);

    const importProfileBtn = document.getElementById('importProfileBtn');
    const importFileInput = document.getElementById('importFileInput');
    if (importProfileBtn && importFileInput) {
        importProfileBtn.addEventListener('click', () => importFileInput.click());
        importFileInput.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (file) {
                await importProfiles(file, showImportResults);
                importFileInput.value = '';
            }
        });
    }

    // Toggle Handlers
    async function onToggleChange(key, inputEl) {
        await storageSet({ [key]: inputEl.checked });
        console.log(`Toggle changed: ${key} = ${inputEl.checked}`);

        if (key === 'autoModIdentificationChecked') {
            await sendMsg('identifyModExtensions');
            await renderExtensionList();
        }
        if (key === 'toggleRandomizeOnSetTimeChecked') {
            await sendMsg('toggleRandomizeOnSetTimeChecked', { value: inputEl.checked });
        }
        if (key === 'uninstallAndReinstallChecked' && !inputEl.checked) {
            removeRedirectMessage();
        }
    }

    els.autoModToggle.addEventListener('change', () => onToggleChange('autoModIdentificationChecked', els.autoModToggle));
    els.openModsToggle.addEventListener('change', () => onToggleChange('uninstallAndReinstallChecked', els.openModsToggle));
    els.openModsTabToggle.addEventListener('change', () => onToggleChange('openModsTabChecked', els.openModsTabToggle));
    els.showNotificationsToggle.addEventListener('change', () => onToggleChange('showNotificationsChecked', els.showNotificationsToggle));
    els.startupToggle.addEventListener('change', () => onToggleChange('toggleRandomizeOnStartupChecked', els.startupToggle));
    els.setTimeToggle.addEventListener('change', () => onToggleChange('toggleRandomizeOnSetTimeChecked', els.setTimeToggle));

    // Time Input
    let timeDebounce = null;
    let lastSubmittedMinutes = null;

    async function onTimeInputChange(evt) {
        if (timeDebounce) clearTimeout(timeDebounce);
        const inputEl = evt?.target || els.timeInput;
        const unitEl = els.timeUnit;
        if (!inputEl || !unitEl) return;

        timeDebounce = setTimeout(async () => {
            const raw = inputEl.value;
            const unit = unitEl.value;

            if (!raw && raw !== '0') {
                // await sendMsg('setRandomizeTime', { time: 0 }); // Actually treating empty as disabled/0
                // Not strictly safe if user is just clearing to type new, but existing logic did this
                return;
            }

            const parsed = parseFloat(raw);
            if (isNaN(parsed)) {
                await customAlert('Invalid time value');
                return;
            }
            if (parsed === 0) {
                await sendMsg('setRandomizeTime', { time: 0 });
                els.timeInput.value = '';
                return;
            }

            // Validations
            if (unit === 'minutes' && parsed < 1 && parsed !== 0.25) {
                await customAlert('Randomize time must be at least 1 minute.');
                return;
            }
            if ((unit === 'hours' || unit === 'days') && parsed < 1) {
                await customAlert(`Randomize time must be at least 1 ${unit}.`);
                return;
            }

            const minutes = toMinutes(parsed, unit);
            if (lastSubmittedMinutes === minutes) return;
            lastSubmittedMinutes = minutes;
            await sendMsg('setRandomizeTime', { time: minutes });

        }, 400);
    }

    async function onTimeUnitChange(evt) {
        const unitEl = evt?.target || els.timeUnit;
        if (!unitEl) return;
        await storageSet({ timeUnit: unitEl.value });

        const s = await storageGet('randomizeTime');
        const minutes = s.randomizeTime;
        if (minutes && minutes > 0) {
            els.timeInput.value = fromMinutesFormat(minutes, unitEl.value);
        }
    }

    if (els.timeInput) els.timeInput.addEventListener('input', onTimeInputChange);
    if (els.timeUnit) els.timeUnit.addEventListener('change', onTimeUnitChange);

    // Search
    els.searchBar.addEventListener('input', () => {
        const q = els.searchBar.value.trim().toLowerCase();
        for (const li of Array.from(els.extensionList.children)) {
            const text = li.textContent.toLowerCase();
            li.style.display = text.includes(q) ? '' : 'none';
        }
    });

    // Bulk Toggles
    if (els.toggleAllBtn) {
        els.toggleAllBtn.addEventListener('click', async () => {
            if (els.extensionList.classList.contains('disabled')) return;
            const checkboxes = els.extensionList.querySelectorAll('input[type="checkbox"]');
            if (!checkboxes.length) return;

            const allChecked = Array.from(checkboxes).every(cb => cb.checked);
            checkboxes.forEach(cb => { cb.checked = !allChecked; });
            await triggerManualSave();
        });
    }
    if (els.reverseAllBtn) {
        els.reverseAllBtn.addEventListener('click', async () => {
            if (els.extensionList.classList.contains('disabled')) return;
            const checkboxes = els.extensionList.querySelectorAll('input[type="checkbox"]');
            if (!checkboxes.length) return;
            checkboxes.forEach(cb => { cb.checked = !cb.checked; });
            await triggerManualSave();
        });
    }

    // Randomize Button
    let redirectTimeoutId = null;

    els.randomizeButton.addEventListener('click', async () => {
        try {
            if (redirectTimeoutId) {
                clearTimeout(redirectTimeoutId);
                redirectTimeoutId = null;
            }

            const st = await storageGet('uninstallAndReinstallChecked');
            const uninstallAndReinstall = !!st.uninstallAndReinstallChecked;

            const modToProcess = await sendMsg('getRandomMod', { uninstallAndReinstall });

            if (!modToProcess || !modToProcess.id) {
                await customAlert('No mod was found to randomize.');
                return;
            }

            if (uninstallAndReinstall && modToProcess.reinstallUrl) {
                await showModMessage(modToProcess, true);
                chrome.tabs.create({ url: modToProcess.reinstallUrl });

                chrome.management.uninstall(modToProcess.id, { showConfirmDialog: true }, () => {
                    if (chrome.runtime.lastError) {
                        if (isSidebar) setTimeout(clearEnabledMessage, 500);
                    } else {
                        if (isSidebar) clearEnabledMessage();
                        else window.close();
                    }
                });
            } else {
                await showModMessage(modToProcess, uninstallAndReinstall && !modToProcess.reinstallUrl);

                if (modToProcess.modsTabUrl) {
                    showRedirectMessage();
                    redirectTimeoutId = setTimeout(() => {
                        removeRedirectMessage();
                        chrome.tabs.create({ url: modToProcess.modsTabUrl });
                        if (isSidebar) clearEnabledMessage();
                        else window.close();
                    }, 3000);
                }
            }

        } catch (error) {
            console.error(error);
            showError(error.message || 'Unknown error');
        }
    });

    // Storage Listener
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.currentMod) refreshCurrentMod();

        const shouldReloadProfiles =
            (changes.profiles && typeof changes.profiles.newValue === 'object' && typeof changes.profiles.oldValue === 'object' &&
                Object.keys(changes.profiles.newValue || {}).join('|') !== Object.keys(changes.profiles.oldValue || {}).join('|'))
            || !!changes.activeProfile;

        if (shouldReloadProfiles) loadAndRenderProfiles();
        renderExtensionList();
    });

});
