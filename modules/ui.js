import { escapeHtml } from './utils.js';
import { storageGet, storageSet, sendMsg } from './api.js';

// DOM elements cache (elements that are always present)
// We export this so we can access them if needed, but primarily used internally
const els = {};

export function initEls() {
    els.profileSelect = document.getElementById('profileSelect');
    els.newProfileBtn = document.getElementById('newProfileBtn');
    els.deleteProfileBtn = document.getElementById('deleteProfileBtn');
    els.autoModToggle = document.getElementById('randomizeAllMods');
    els.openModsToggle = document.getElementById('uninstallAndReinstall');
    els.openModsTabToggle = document.getElementById('openModsTab');
    els.showNotificationsToggle = document.getElementById('showNotifications');
    els.startupToggle = document.getElementById('toggleRandomizeOnStartup');
    els.setTimeToggle = document.getElementById('toggleRandomizeOnSetTime');
    els.timeInput = document.getElementById('timeInput');
    els.timeUnit = document.getElementById('timeUnitSelect');
    els.randomizeButton = document.getElementById('randomizeButton');
    els.extensionList = document.getElementById('extensionList');
    els.searchBar = document.getElementById('searchBar');
    els.currentMod = document.getElementById('current-mod');
    els.message = document.getElementById('message');
    els.toggleAllBtn = document.getElementById('toggleAllBtn');
    els.reverseAllBtn = document.getElementById('reverseAllBtn');
    return els;
}

// Accessor for current UI state
export function getEls() {
    return els;
}

export function showError(text) {
    if (!els.message) return;
    els.message.textContent = text;
    setTimeout(() => { if (els.message.textContent === text) els.message.textContent = ''; }, 4000);
}

// --- Message Area Management ---
// Wraps logic for ensuring message containers exist
function ensureMessageAreas() {
    if (!els.randomizeButton) return {};

    let permanentHr = document.getElementById('message-hr');
    if (!permanentHr) {
        permanentHr = document.createElement('hr');
        permanentHr.id = 'message-hr';
        els.randomizeButton.insertAdjacentElement('afterend', permanentHr);
    }
    let enabledArea = document.getElementById('enabled-area');
    if (!enabledArea) {
        enabledArea = document.createElement('div');
        enabledArea.id = 'enabled-area';
        permanentHr.insertAdjacentElement('afterend', enabledArea);
    } else {
        if (permanentHr.nextElementSibling !== enabledArea) {
            permanentHr.insertAdjacentElement('afterend', enabledArea);
        }
    }
    let redirectArea = document.getElementById('redirect-area');
    if (!redirectArea) {
        redirectArea = document.createElement('div');
        redirectArea.id = 'redirect-area';
        enabledArea.insertAdjacentElement('afterend', redirectArea);
    } else if (redirectArea.previousElementSibling !== enabledArea) {
        enabledArea.insertAdjacentElement('afterend', redirectArea);
    }
    return { permanentHr, enabledArea, redirectArea };
}

function ensureTempSeparator() {
    const { enabledArea, redirectArea } = ensureMessageAreas();
    let tempHr = document.getElementById('message-temp-hr');
    if (!tempHr) {
        tempHr = document.createElement('hr');
        tempHr.id = 'message-temp-hr';
    }
    const anchor = (redirectArea && redirectArea.childElementCount > 0) ? redirectArea : enabledArea;
    if (anchor && anchor.nextElementSibling !== tempHr) {
        anchor.insertAdjacentElement('afterend', tempHr);
    }
}

function removeMessageAreasIfEmpty() {
    const enabledArea = document.getElementById('enabled-area');
    const redirectArea = document.getElementById('redirect-area');
    const permanentHr = document.getElementById('message-hr');
    const tempHr = document.getElementById('message-temp-hr');

    const enabledEmpty = !enabledArea || enabledArea.childElementCount === 0;
    const redirectEmpty = !redirectArea || redirectArea.childElementCount === 0;

    if (enabledEmpty && redirectEmpty) {
        if (enabledArea) enabledArea.remove();
        if (redirectArea) redirectArea.remove();
        if (permanentHr) permanentHr.remove();
        if (tempHr) tempHr.remove();
    }
}

// Public Message Functions
export function clearEnabledMessage() {
    const enabledArea = document.getElementById('enabled-area');
    if (enabledArea) {
        enabledArea.innerHTML = '';
    }
    removeMessageAreasIfEmpty();
}

let autoClearTimerId = null;
let redirectTimeoutId = null;
let redirectIntervalId = null;

export async function showModMessage(mod, uninstallAndReinstall) {
    const { enabledArea, redirectArea } = ensureMessageAreas();

    // Clear previous timers (if any exposed/tracked)
    // Note: global timers were in popup.js, here we scope them if possible or ignore
    // For simplicity, we just clear DOM
    enabledArea.innerHTML = '';
    redirectArea.innerHTML = '';

    const d = document.createElement('div');
    d.id = 'modMessage';
    d.style.textAlign = 'center';

    const messageText = document.createElement('div');
    messageText.style.color = 'var(--success)';
    messageText.style.marginBottom = '8px';

    if (uninstallAndReinstall && !mod.reinstallUrl) {
        const name = mod.name ? escapeHtml(mod.name) : '(unknown)';
        messageText.innerHTML = `URL missing- Enabled: <span class="mod-name">${name}</span>`;
    } else {
        const label = uninstallAndReinstall ? 'Chose Mod' : 'Enabled Mod';
        const name = mod.name ? escapeHtml(mod.name) : '(unknown)';
        messageText.innerHTML = `${label}: <span class="mod-name">${name}</span>`;
    }

    d.appendChild(messageText);
    enabledArea.appendChild(d);

    ensureTempSeparator();
}

export function showRedirectMessage() {
    const { redirectArea } = ensureMessageAreas();
    redirectArea.innerHTML = '';

    const placeholder = document.createElement('p');
    placeholder.className = 'redirect-message';
    placeholder.textContent = 'Redirecting to enable checkmarks';
    let dots = '';
    const interval = setInterval(() => {
        dots = dots.length < 3 ? dots + '.' : '';
        placeholder.textContent = 'Redirecting to enable checkmarks' + dots;
    }, 300);
    placeholder.dataset.intervalId = String(interval); // We can parse this back if needed

    redirectArea.appendChild(placeholder);
    ensureTempSeparator();
}

export function removeRedirectMessage() {
    const redirectArea = document.getElementById('redirect-area');
    if (redirectArea) {
        const el = redirectArea.querySelector('.redirect-message');
        if (el?.dataset.intervalId) clearInterval(parseInt(el.dataset.intervalId));
        redirectArea.innerHTML = '';
    }
    removeMessageAreasIfEmpty();
}

// --- Import Results Modal ---
export async function showImportResults(results) {
    const overlay = document.getElementById('modalOverlay');
    const titleEl = document.getElementById('modalTitle');
    const messageEl = document.getElementById('modalMessage');
    const inputEl = document.getElementById('modalInput');
    const buttonsEl = document.getElementById('modalButtons');

    titleEl.textContent = 'Import Results';
    inputEl.style.display = 'none';

    let html = '<div class="import-results">';
    if (results.imported.length > 0) {
        html += '<h4>✓ Imported Profiles:</h4><ul>';
        results.imported.forEach(name => {
            html += `<li>${escapeHtml(name)}`;
            if (results.missingMods[name]) {
                html += ` <span style="color: var(--highlight);">(${results.missingMods[name].length} mod(s) missing)</span>`;
            }
            html += '</li>';
        });
        html += '</ul>';

        const profilesWithMissing = Object.keys(results.missingMods);
        if (profilesWithMissing.length > 0) {
            html += '<div class="import-warning"><h4>⚠ Missing Mods:</h4>';
            profilesWithMissing.forEach(profileName => {
                html += `<strong>${escapeHtml(profileName)}:</strong><ul>`;
                results.missingMods[profileName].forEach(modName => {
                    html += `<li>${escapeHtml(modName)}</li>`;
                });
                html += '</ul>';
            });
            html += '<p>These mods were not found on your system and were excluded.</p></div>';
        }
    }

    if (results.skipped.length > 0) {
        html += '<h4>⊘ Skipped:</h4><ul>';
        results.skipped.forEach(name => {
            html += `<li>${escapeHtml(name)}</li>`;
        });
        html += '</ul>';
        html += '<p class="import-warning">Profiles with these names already exist.</p>';
    }

    if (results.imported.length === 0 && results.skipped.length === 0) {
        html += '<p class="import-warning">No profiles were imported.</p>';
    } else if (results.imported.length > 0) {
        html += `<p class="import-success">Successfully imported ${results.imported.length} profile(s)!</p>`;
    }

    html += '</div>';
    messageEl.innerHTML = html;

    buttonsEl.innerHTML = '';
    const okBtn = document.createElement('button');
    okBtn.className = 'modal-btn modal-btn-primary';
    okBtn.textContent = 'OK';
    okBtn.onclick = () => overlay.classList.remove('active');
    buttonsEl.appendChild(okBtn);

    overlay.classList.add('active');
    setTimeout(() => okBtn.focus(), 100);
}

// --- Extension List Rendering ---
let renderLock = false; // prevents mid-save re-renders
let manualSaveDebounce = null;
let pendingSaveProfile = null;
let currentProfileName = null; // Tracked internally or passed in

export function setRenderLock(val) { renderLock = val; }
export function getRenderLock() { return renderLock; }

// Callback for when checkboxes change
let onManualCheckboxChangeCallback = null;
export function setOnManualCheckboxChangeCallback(cb) {
    onManualCheckboxChangeCallback = cb;
}

export async function renderExtensionList(forceProfileName = null) {
    if (renderLock) return;

    // fetch everything
    const resp = await sendMsg('getExtensions');

    const settings = await storageGet(['autoModIdentificationChecked', 'profilesOrder']);
    const randomizeAll = settings.autoModIdentificationChecked === undefined
        ? true
        : !!settings.autoModIdentificationChecked;

    // Sync toggle UI if needed
    if (els.autoModToggle && els.autoModToggle.checked !== randomizeAll) {
        els.autoModToggle.checked = randomizeAll;
    }

    const profileSection = document.querySelector('.profile-section');
    if (randomizeAll) {
        els.extensionList.parentElement.classList.add("disabled");
        if (profileSection) profileSection.classList.add("disabled");
    } else {
        els.extensionList.parentElement.classList.remove("disabled");
        if (profileSection) profileSection.classList.remove("disabled");
    }

    const detected = resp?.detectedModList
        || (resp?.extensions ? resp.extensions.filter(e => e.updateUrl === 'https://api.gx.me/store/mods/update').map(e => ({ id: e.id, name: e.name })) : []);
    const profiles = resp?.profiles || (await storageGet('profiles')).profiles || { Default: [] };

    // Fetch recently uninstalled for name fallback
    const recentlyUninstalled = (await storageGet('recentlyUninstalled')).recentlyUninstalled || {};

    // Choose profile
    const active = forceProfileName
        || (resp?.activeProfile || (await storageGet('activeProfile')).activeProfile || Object.keys(profiles)[0] || 'Default');

    currentProfileName = active;

    els.extensionList.dataset.profile = active;
    const profileList = Array.isArray(profiles[active]) ? profiles[active] : [];
    const detectedMap = new Map((detected || []).map(d => [d.id, d.name]));

    // profilesOrder
    let profilesOrder = settings.profilesOrder || {};
    if (!profilesOrder[active]) {
        profilesOrder[active] = [...profileList];
        await storageSet({ profilesOrder });
    }

    // Build display order
    const order = profilesOrder[active].slice();
    const seen = new Set(order);
    for (const id of profileList) if (!seen.has(id)) { order.push(id); seen.add(id); }
    for (const d of detected) if (!seen.has(d.id)) { order.push(d.id); seen.add(d.id); }

    // Sort
    const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
    const sortedOrder = order.slice().sort((a, b) => {
        const nameA = (detectedMap.get(a) || 'Unknown Mod (not detected)');
        const nameB = (detectedMap.get(b) || 'Unknown Mod (not detected)');
        return collator.compare(nameA, nameB);
    });

    // Render
    els.extensionList.innerHTML = '';
    els.extensionList.classList.toggle('disabled', randomizeAll);

    // Helper for checkbox change
    const handleCheckboxChange = async () => {
        // Debounce logic moved here or in popup?
        // Let's implement debounce here as it was in popup
        renderLock = true;
        if (manualSaveDebounce) clearTimeout(manualSaveDebounce);

        pendingSaveProfile = els.extensionList.dataset.profile || currentProfileName || 'Default';

        manualSaveDebounce = setTimeout(async () => {
            const checkedIds = Array.from(els.extensionList.querySelectorAll('input[type="checkbox"]'))
                .filter(cb => cb.checked)
                .map(cb => cb.dataset.extid);

            const activeForSave = pendingSaveProfile;

            // Update order
            const st = await storageGet('profilesOrder');
            const pOrder = st.profilesOrder || {};
            pOrder[activeForSave] = pOrder[activeForSave] || [];

            let changed = false;
            for (const id of checkedIds) {
                if (!pOrder[activeForSave].includes(id)) { pOrder[activeForSave].push(id); changed = true; }
            }
            if (changed) {
                await storageSet({ profilesOrder: pOrder });
            }

            const saveRes = await sendMsg('saveModExtensionIds', { modExtensionIds: checkedIds, profileName: activeForSave });
            console.log(`Saved ${checkedIds.length} mods to profile "${activeForSave}"`);

            pendingSaveProfile = null;
            setTimeout(() => { renderLock = false; }, 100);
        }, 120);
    };

    for (const id of sortedOrder) {
        let name = detectedMap.get(id);
        if (!name) {
            if (recentlyUninstalled[id] && recentlyUninstalled[id].name) {
                name = recentlyUninstalled[id].name; // + ' (temporarily saved)';
            } else {
                name = 'Unknown Mod (not detected)';
            }
        }
        const li = document.createElement('li');
        li.dataset.extid = id;

        const label = document.createElement('span');
        label.textContent = name;
        label.title = name;
        label.style.flex = '1';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.extid = id;

        if (randomizeAll) {
            cb.checked = true;
            cb.disabled = true;
        } else {
            cb.checked = profileList.includes(id);
            cb.disabled = false;
            cb.addEventListener('change', handleCheckboxChange);
        }

        li.appendChild(cb);
        li.appendChild(label);
        els.extensionList.appendChild(li);
    }

    // Also export a trigger for external bulk toggles
    return { handleCheckboxChange };
}

// We expose the last created handleCheckboxChange so bulk toggles can use it
// But since handleCheckboxChange is scoped per render, we need a way to invoke the logic.
// Simpler: Duplicate the logic or expose a shared saver function.
// Let's expose `triggerManualSave` which does the debounce logic.

export async function triggerManualSave() {
    // Reuse the logic inside renderExtensionList's handler
    // We can just query selector logic again
    renderLock = true;
    if (manualSaveDebounce) clearTimeout(manualSaveDebounce);

    pendingSaveProfile = els.extensionList.dataset.profile || currentProfileName || 'Default';

    manualSaveDebounce = setTimeout(async () => {
        const checkedIds = Array.from(els.extensionList.querySelectorAll('input[type="checkbox"]'))
            .filter(cb => cb.checked)
            .map(cb => cb.dataset.extid);

        const activeForSave = pendingSaveProfile;

        const st = await storageGet('profilesOrder');
        const pOrder = st.profilesOrder || {};
        pOrder[activeForSave] = pOrder[activeForSave] || [];

        let changed = false;
        for (const id of checkedIds) {
            if (!pOrder[activeForSave].includes(id)) { pOrder[activeForSave].push(id); changed = true; }
        }
        if (changed) {
            await storageSet({ profilesOrder: pOrder });
        }

        await sendMsg('saveModExtensionIds', { modExtensionIds: checkedIds, profileName: activeForSave });
        console.log(`Saved ${checkedIds.length} mods to profile "${activeForSave}"`);

        pendingSaveProfile = null;
        setTimeout(() => { renderLock = false; }, 100);
    }, 120);
}
