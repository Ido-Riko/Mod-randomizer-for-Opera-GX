import { storageGet, storageSet, sendMsg } from './api.js';
import { customAlert, customPrompt, customConfirmDanger } from './utils.js';
import { getEls, renderExtensionList } from './ui.js';

let currentProfile = null;

export function getCurrentProfile() { return currentProfile; }
export function setCurrentProfile(p) { currentProfile = p; }

// --- helpers ---
export async function ensureProfilesOrder(profiles) {
    const st = await storageGet('profilesOrder');
    let profilesOrder = st.profilesOrder || {};
    let changed = false;
    for (const profileName of Object.keys(profiles)) {
        if (!profilesOrder[profileName]) {
            profilesOrder[profileName] = Array.isArray(profiles[profileName]) ? [...profiles[profileName]] : [];
            changed = true;
        } else {
            const enabled = Array.isArray(profiles[profileName]) ? profiles[profileName] : [];
            for (const id of enabled) {
                if (!profilesOrder[profileName].includes(id)) {
                    profilesOrder[profileName].push(id);
                    changed = true;
                }
            }
        }
    }
    if (changed) {
        await storageSet({ profilesOrder });
        console.log('Initialized/updated profilesOrder');
    }
    return profilesOrder;
}

export async function loadAndRenderProfiles() {
    // Avoid extra background round-trip; only profiles/activeProfile are needed here
    const s = await storageGet(['profiles', 'activeProfile']);
    const profiles = s?.profiles || { Default: [] };
    const activeProfile = s?.activeProfile || Object.keys(profiles)[0] || 'Default';

    // Keep a stable notion of the current profile in the popup:
    if (!currentProfile || profiles[currentProfile] === undefined) {
        currentProfile = activeProfile;
    }

    const els = getEls();
    if (!els.profileSelect) return;

    // populate select
    els.profileSelect.innerHTML = '';
    for (const name of Object.keys(profiles)) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        if (name === currentProfile) opt.selected = true;
        els.profileSelect.appendChild(opt);
    }

    // Ensure the select reflects the currentProfile explicitly
    els.profileSelect.value = currentProfile;

    // Make sure profilesOrder exists and includes these profiles
    await ensureProfilesOrder(profiles);

    // Wire rename by double-click on select
    if (!els.profileSelect._hasDbl) {
        els.profileSelect.addEventListener('dblclick', async () => {
            const oldName = els.profileSelect.value;
            const newNameRaw = await customPrompt('Enter new profile name:', oldName, 'Rename Profile');
            const newName = (newNameRaw || '').trim();
            if (!newName || newName === oldName) return;

            // Prevent accidental duplicates (case-insensitive) on the client side
            const names = Object.keys(profiles);
            if (names.some(n => n.toLowerCase() === newName.toLowerCase() && n !== oldName)) {
                await customAlert('A profile with this name already exists.');
                return;
            }

            const res = await sendMsg('renameProfile', { oldName, newName });
            if (res && res.status === 'success') {
                // If we store profilesOrder locally, rename that too
                const st = await storageGet('profilesOrder');
                const po = st.profilesOrder || {};
                if (po[oldName]) {
                    po[newName] = po[oldName];
                    delete po[oldName];
                    await storageSet({ profilesOrder: po });
                }
                console.log(`Renamed profile ${oldName} -> ${newName}`);
                await loadAndRenderProfiles();
            } else {
                await customAlert(res && res.message ? res.message : 'Rename failed');
            }
        });
        els.profileSelect._hasDbl = true;
    }
}

// Export/Import Logic
export async function exportProfiles() {
    try {
        const s = await storageGet(['profiles', 'detectedModList']);
        const profiles = s.profiles || {};
        const detectedModList = s.detectedModList || [];

        if (Object.keys(profiles).length === 0) {
            await customAlert('No profiles to export.', 'Export');
            return;
        }

        const modIdToName = new Map(detectedModList.map(m => [m.id, m.name]));

        const exportData = {
            version: 1,
            exportDate: new Date().toISOString(),
            profiles: {}
        };

        for (const [profileName, modIds] of Object.entries(profiles)) {
            exportData.profiles[profileName] = (modIds || []).map(id => ({
                id: id,
                name: modIdToName.get(id) || `Unknown (${id})`
            }));
        }

        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mod-randomizer-profiles-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log('Profiles exported successfully');
        await customAlert(`Exported ${Object.keys(profiles).length} profile(s)`, 'Export Successful');
    } catch (err) {
        console.error('Export error:', err);
        await customAlert('Failed to export profiles: ' + err.message, 'Export Error');
    }
}

export async function importProfiles(file, showImportResultsCallback) {
    try {
        const text = await file.text();
        const importData = JSON.parse(text);

        if (!importData.profiles || typeof importData.profiles !== 'object') {
            throw new Error('Invalid profile file format');
        }

        const s = await storageGet(['profiles', 'profilesOrder', 'detectedModList']);
        const existingProfiles = s.profiles || {};
        const existingOrder = s.profilesOrder || {};
        const detectedModList = s.detectedModList || [];

        const modNameToId = new Map(detectedModList.map(m => [m.name.toLowerCase(), m.id]));
        const detectedIds = new Set(detectedModList.map(m => m.id));

        const results = {
            imported: [],
            skipped: [],
            missingMods: {}
        };

        for (const [profileName, modsArray] of Object.entries(importData.profiles)) {
            const existingNames = Object.keys(existingProfiles).map(n => n.toLowerCase());
            if (existingNames.includes(profileName.toLowerCase())) {
                results.skipped.push(profileName);
                continue;
            }

            if (!modsArray || modsArray.length === 0) {
                existingProfiles[profileName] = [];
                existingOrder[profileName] = [];
                results.imported.push(profileName);
                continue;
            }

            const validModIds = [];
            const missingMods = [];

            for (const mod of modsArray) {
                const modId = mod.id || mod;
                const modName = mod.name;

                if (detectedIds.has(modId)) {
                    validModIds.push(modId);
                } else if (modName) {
                    const matchedId = modNameToId.get(modName.toLowerCase());
                    if (matchedId) {
                        validModIds.push(matchedId);
                    } else {
                        missingMods.push(modName);
                    }
                } else {
                    missingMods.push(`Unknown (${modId})`);
                }
            }

            existingProfiles[profileName] = validModIds;
            existingOrder[profileName] = validModIds;

            results.imported.push(profileName);
            if (missingMods.length > 0) {
                results.missingMods[profileName] = missingMods;
            }
        }

        if (results.imported.length > 0) {
            await storageSet({ profiles: existingProfiles, profilesOrder: existingOrder });
            await loadAndRenderProfiles();
            // We need to request renderExtensionList, probably passed as callback or imported circular (careful with circular)
            // Ideally we just update data, then popup.js orchestrator calls render. 
            // BUT profiles.js imports renderExtensionList from ui.js so we can call it.
            await renderExtensionList();
        }

        if (showImportResultsCallback) {
            await showImportResultsCallback(results);
        }

    } catch (err) {
        console.error('Import error:', err);
        await customAlert('Failed to import profiles: ' + err.message, 'Import Error');
    }
}
