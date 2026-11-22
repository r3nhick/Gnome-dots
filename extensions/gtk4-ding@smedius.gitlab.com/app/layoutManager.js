/* DING: Desktop Icons New Generation for GNOME Shell
 *
 * Gtk4 Port Copyright (C) 2022 - 2026 Sundeep Mediratta (smedius@gmail.com)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/*
 * Preserve the user's sense of where icons belong when monitors change.
 *
 * Treat the desktop as one arrangement across all monitors. Preserve familiar
 * groups, ordering and relationships to edges. Respect manual placement.
 *
 * Profiles remember established arrangements. Temporary adjustments must not
 * overwrite them or create unnecessary profiles.
 *
 * This manager decides icon positions and manages layout memory.
 * DesktopGrid displays the result; DesktopManager coordinates app operations.
 * See Layout_Manager_Design.md for the design goals and remaining work.
 */

import {Gio, GLib} from '../dependencies/gi.js';
import {WebCola} from '../dependencies/localFiles.js';

export class LayoutManager {
    // Construction and owned state

    constructor(desktopUtilities) {
        // Profile identity and remembered arrangements.
        this._currentMonitorConfiguration = null;
        this._namespace = null;
        this._profiles = new Map();
        // Remembered arrangements are separate from live monitor enumeration.
        this._rememberedLayouts = new Map();
        this._profileTransition = null;
        this._sourceLayout = null;
        // No saved source on first startup: sequential placement starts empty.
        this._destinationMonitorIndices = new Map();
        this._lastActiveProfileKeysByNamespace = {};

        // Live geometry and occupancy shared with DesktopGrid.
        this._gridGeometries = new Map();
        this._gridOccupancy = new Map();

        // Persistence resources, pending writes and startup readiness.
        this._pendingSave = null;
        this._saveTimeoutId = 0;
        this._desktopUtilities = desktopUtilities;
        this._layoutsStateFile = desktopUtilities.getLayoutsStateFile();
        this._savingProfiles = null;
        this._loadProfilesPromise = this._initializeProfiles();
    }

    // Profile configuration and identity
    // Track the live monitor configuration and construct deterministic keys.

    setNamespace(desktopNamespace) {
        this._namespace = desktopNamespace;

        if (this._currentMonitorConfiguration) {
            const profileKey = this._createProfileKey(
                desktopNamespace, this._currentMonitorConfiguration.monitors
            );

            this._currentMonitorConfiguration = Object.freeze({
                ...this._currentMonitorConfiguration,
                namespace: desktopNamespace,
                key: profileKey,
            });

            this._registerCurrentProfile();
        }
    }

    updateMonitorConfiguration(desktopList, monitorMembers) {
        const logicalMonitors = desktopList.map(monitorGeometry => {
            // Preserve DesktopGrid's conversion to logical dimensions.
            // Margins are excluded from these monitor-local bounds.
            const geometryDivisor = monitorGeometry.scaleFactor === 1
                ? 1 : monitorGeometry.zoom;

            const logicalWidth =
                Math.floor(monitorGeometry.width / geometryDivisor);

            const logicalHeight =
                Math.floor(monitorGeometry.height / geometryDivisor);

            if (!Number.isFinite(logicalWidth) ||
                !Number.isFinite(logicalHeight) ||
                logicalWidth <= 0 || logicalHeight <= 0)
                throw new Error('Invalid logical monitor dimensions');

            // monitorMembers = {
            //     0: [
            //         {connector: 'DP-1', vendor: '...',
            //          product: '...', serial: '...'},
            //         {connector: 'HDMI-1', vendor: '...',
            //          product: '...', serial: '...'},
            //     ],
            // };
            // Each value is an array: mirrored displays share one logical
            // monitor. Copy specifications without freezing the input objects.
            const physicalMonitors =
                monitorMembers[monitorGeometry.monitorIndex] ?? [];

            const physicalSpecifications = physicalMonitors.map(
                physicalMonitor => Object.freeze({
                    connector: physicalMonitor.connector ?? '',
                    vendor: physicalMonitor.vendor ?? '',
                    product: physicalMonitor.product ?? '',
                    serial: physicalMonitor.serial ?? '',
                })
            );

            return Object.freeze({
                monitorIndex: monitorGeometry.monitorIndex,
                width: logicalWidth,
                height: logicalHeight,
                members: Object.freeze(physicalSpecifications),
            });
        });

        const profileKey =
            this._createProfileKey(this._namespace, logicalMonitors);

        const previousProfileKey = this._currentMonitorConfiguration?.key;

        // Stored profile shape: {namespace, key, monitors: [
        //     {monitorIndex, width, height, members: [
        //         {connector, vendor, product, serial}, ...
        //     ]}, ...
        // ]}.
        // Live monitor/member order is preserved; only key inputs are sorted.
        this._currentMonitorConfiguration = Object.freeze({
            namespace: this._namespace,
            key: profileKey,
            monitors: Object.freeze(logicalMonitors),
        });

        this._registerCurrentProfile();
        return previousProfileKey !== undefined &&
            previousProfileKey !== this._currentMonitorConfiguration.key;
    }

    _registerCurrentProfile() {
        const configuration = this._currentMonitorConfiguration;
        const profileKey = this._findMatchingProfileKey(configuration);

        if (profileKey !== configuration.key) {
            // Discard only a provisional registration made before disk loaded.
            if (this._profiles.get(configuration.key) === configuration &&
                !this._rememberedLayouts.has(configuration.key))
                this._profiles.delete(configuration.key);

            this._currentMonitorConfiguration = Object.freeze({
                ...configuration, key: profileKey,
            });
        }

        if (this._profileTransition?.destination.profileKey !== profileKey) {
            const previousProfileKey =
                this._profileTransition?.destination.profileKey ??
                this._lastActiveProfileKeysByNamespace[this._namespace];
            const previousLayout =
                this._rememberedLayouts.get(previousProfileKey);
            const sourceLayout = previousLayout?.namespace === this._namespace
                ? previousLayout : null;
            const destinationLayout =
                this._rememberedLayouts.get(profileKey) ?? null;

            this._profileTransition = Object.freeze({
                source: sourceLayout ? Object.freeze({
                    profileKey: previousProfileKey,
                    layout: sourceLayout,
                }) : null,
                destination: Object.freeze({
                    profileKey,
                    layout: destinationLayout,
                }),
                requiresTransformation:
                    sourceLayout !== null && destinationLayout === null,
            });
        }

        this._sourceLayout = this.rememberedLayout ??
            this._rememberedLayouts.get(
                this._profileTransition.source?.profileKey
            ) ?? null;

        if (!this._sourceLayout)
            this._destinationMonitorIndices = new Map();

        // Seed unseen configurations only. Returning to a known key retains
        // its remembered data, including placements loaded from disk.
        // Live order and indices continue to update in the current snapshot.
        // Saved monitor indices are historical, not rendering destinations.
        if (!this._profiles.has(profileKey)) {
            this._profiles.set(profileKey, this._currentMonitorConfiguration);
            this._queueSave();
        }
    }

    // Prefer exact memory. Otherwise reuse one uniquely matching physical
    // configuration at the same resolutions, regardless of connector names.
    _findMatchingProfileKey(configuration) {
        this._clearDestinationMonitorIndices();
        const exactLayout = this._rememberedLayouts.get(configuration.key);

        if (exactLayout) {
            this._destinationMonitorIndices = this._resolveSourceMonitorIndices(
                exactLayout, configuration.monitors
            );
            return configuration.key;
        }

        const matchingProfiles = [];

        for (const [key, layout] of this._rememberedLayouts) {
            if (layout.namespace !== configuration.namespace ||
                Object.keys(layout.monitors).length !==
                    configuration.monitors.length)
                continue;

            const destinations = this._resolveSourceMonitorIndices(
                layout, configuration.monitors
            );
            const matches = Object.entries(layout.monitors).every(
                ([reference, savedMonitor]) => {
                    const currentMonitor = configuration.monitors.find(
                        monitor => monitor.monitorIndex ===
                            destinations.get(reference)
                    );

                    return currentMonitor &&
                        currentMonitor.width === savedMonitor.width &&
                        currentMonitor.height === savedMonitor.height;
                }
            );

            if (matches)
                matchingProfiles.push({key, destinations});
        }

        if (matchingProfiles.length === 1) {
            const match = matchingProfiles[0];
            this._destinationMonitorIndices = match.destinations;
            return match.key;
        }

        return configuration.key;
    }

    _createProfileKey(desktopNamespace, logicalMonitors) {
        // Canonical JSON encoding preserves field boundaries. Sort encoded
        // physical tuples within each group, then encoded logical groups.
        // Thus member order and GNOME enumeration cannot affect the key;
        // group boundaries still distinguish mirrored and extended displays.
        // Sorting costs O(m log m + sum(k log k)), excluding string lengths,
        // for m logical monitors with k physical members in each group.
        // Missing specifications can collide; connector changes change keys.
        // Restoration can reuse a uniquely matched saved key across connectors.
        const canonicalLogicalMonitors = logicalMonitors.map(
            logicalMonitor => {
                const canonicalPhysicalSpecifications =
                    logicalMonitor.members.map(physicalSpecification =>
                        JSON.stringify([
                            physicalSpecification.connector,
                            physicalSpecification.vendor,
                            physicalSpecification.product,
                            physicalSpecification.serial,
                        ])).sort();

                return JSON.stringify({
                    width: logicalMonitor.width,
                    height: logicalMonitor.height,
                    members: canonicalPhysicalSpecifications,
                });
            }
        ).sort();

        return JSON.stringify({
            namespace: desktopNamespace,
            monitors: canonicalLogicalMonitors,
        });
    }

    // Layout capture and memory
    // Capture settled arrangements and retain accepted positions independently
    // of temporary display adaptations.

    /*
     * Return an observation, not an authoritative profile or a disk save.
     * Shape:
     * {
     *     key: '<profile key>', namespace: 'file:///home/user/Desktop',
     *     snappedToGrid: false,
     *     monitors: {
     *         m0: {
     *             members: [{connector, vendor, product, serial}],
     *             width: 1920, height: 1080,
     *             usableWidth: 1920, usableHeight: 1040,
     *             grid: {columnCount: 16, rowCount: 8},
     *         },
     *     },
     *     placements: {
     *         icons: {'file:///desktop/file': {monitor: 'm0', x: 10, y: 20}},
     *         widgets: {'<instanceId>': {
     *             monitor: 'm0', x: -12, y: 100, width: 320, height: 240,
     *         }},
     *     },
     * }
     * Monitor width/height are full logical dimensions used in profile keys.
     * Usable dimensions are the normalization basis after desktop margins.
     * X/Y are local pixels, including negatives; aligned icon/widget
     * containers have numerically corresponding positions. No global or
     * normalized coordinates are stored. Widget width/height are its size.
     * Monitor references are snapshot-local, not GNOME indices or slot IDs.
     * Mirrored members share one entry. Mode-specific capture supplies the
     * original positions, including hidden stacked files, never stack markers.
     * Stacked capture reads profile memory except for explicitly edited icons.
     * Authority is assigned only when accepting edits.
     * Returns null until a current monitor configuration is available.
     */
    captureLayout(desktops, widgetPlacements, originalIcons = null,
        stacked = false, editedIconUris = [], snappedToGrid = false) {
        if (!this._currentMonitorConfiguration)
            return null;

        const logicalMonitors =
            this._currentMonitorConfiguration.monitors;

        // Stack-display coordinates are never individual layout memory.
        // Only explicit moves capture live coordinates while stacked.
        const rememberedIcons = stacked
            ? this.createRestorePlan(desktops)?.icons ?? {} : {};
        const editedIcons = new Set(editedIconUris);
        const individualIcons = originalIcons ?? (stacked ? [] : null);
        const originalPositions = individualIcons?.map(fileItem => {
            if (stacked && !editedIcons.has(fileItem.uri)) {
                const position = rememberedIcons[fileItem.uri];
                const desktop = position && desktops.find(surface =>
                    surface.monitorIndex === position.monitorIndex);

                return {
                    uri: fileItem.uri,
                    savedCoordinates: desktop
                        ? desktop.coordinatesLocalToGlobal(
                            position.x, position.y) : null,
                    monitorIndex: position?.monitorIndex,
                };
            }

            return {
                uri: fileItem.uri,
                savedCoordinates: fileItem.savedCoordinates,
                monitorIndex: fileItem._monitorIndex,
            };
        });

        const monitors = {};
        const monitorReferences = new Map();
        const icons = {};
        const widgets = {};

        for (const desktop of desktops) {
            const monitor = logicalMonitors.find(logicalMonitor =>
                logicalMonitor.monitorIndex === desktop.monitorIndex);

            if (!monitor)
                continue;

            const monitorReference = `m${monitorReferences.size}`;
            monitorReferences.set(desktop.monitorIndex, monitorReference);
            // Keep the saved identity consistent with its existing profile key;
            // the live configuration still reports the current connector.
            const savedMonitor = this.rememberedLayout
                ? this._getSavedMonitorForDesktop(this.rememberedLayout, desktop)
                : null;
            monitors[monitorReference] = {
                ...this._copyLayoutMonitor(savedMonitor ?? monitor),
                usableWidth: desktop.normalizedWidth,
                usableHeight: desktop.normalizedHeight,
            };

            const grid = this._gridGeometries?.get(desktop.index);

            if (grid) {
                monitors[monitorReference].grid = {
                    columnCount: grid.columnCount, rowCount: grid.rowCount,
                };
            }

            const iconPlacements =
                desktop.exportIconPlacements(originalPositions);

            for (const [iconUri, position] of Object.entries(iconPlacements)) {
                icons[iconUri] = {
                    monitor: monitorReference,
                    x: position.x,
                    y: position.y,
                };
            }
        }

        // New stacked files deliberately have no original position yet. They
        // enter layout memory only after unstacking assigns one. A known
        // original that cannot be resolved is still an error.
        if (originalPositions?.some(position =>
            position.savedCoordinates != null &&
            !Object.hasOwn(icons, position.uri)))
            throw new Error('An original icon position could not be captured');

        for (const [instanceId, placement] of
            Object.entries(widgetPlacements)) {
            const monitorReference =
                monitorReferences.get(placement.monitorIndex);

            if (monitorReference === undefined)
                continue;

            widgets[instanceId] = {
                monitor: monitorReference,
                x: placement.x,
                y: placement.y,
                width: placement.width,
                height: placement.height,
            };
        }

        return {
            key: this._currentMonitorConfiguration.key,
            namespace: this._namespace,
            snappedToGrid: stacked
                ? this.rememberedLayout?.snappedToGrid ?? false
                : snappedToGrid,
            monitors,
            placements: {icons, widgets},
        };
    }

    // A settled observation adds baselines for new items. Only explicitly
    // named edits replace known positions; absence never deletes memory.
    // Effective adaptations of known items are deliberately ignored.
    // Explicit drags use 'user'; accepted pinned feedback uses 'established'
    // without claiming whether the compositor or the user initiated the move.
    reconcileLayout(snapshot, iconUris = [], widgetIds = [],
        placementAuthority = 'user') {
        if (!snapshot)
            return;

        if (snapshot.key !== this._currentMonitorConfiguration?.key ||
            snapshot.namespace !== this._namespace)
            throw new Error('Layout belongs to another configuration');

        this._rememberLayout(snapshot);
        const rememberedLayout = this.rememberedLayout;
        const changes = [];

        for (const [kind, identities] of
            Object.entries({icons: iconUris, widgets: widgetIds})) {
            const intentionalItems = new Set(identities);

            for (const [identity, position] of
                Object.entries(snapshot.placements[kind])) {
                const isNew = !Object.hasOwn(
                    rememberedLayout.placements[kind], identity
                );

                if (isNew || intentionalItems.has(identity)) {
                    changes.push({
                        kind, identity, position,
                        authority: intentionalItems.has(identity)
                            ? placementAuthority : 'baseline',
                    });
                }
            }
        }

        if (!changes.length)
            return;

        let updatedLayout = null;

        for (const {kind, identity, position, authority} of changes) {
            const sourceMonitor = snapshot.monitors[position.monitor];
            const sourceKey = this._createProfileKey('', [sourceMonitor]);

            const matches = Object.entries(rememberedLayout.monitors).filter(
                ([, monitor]) => this._createProfileKey('', [monitor]) ===
                    sourceKey
            );

            // Do not guess which indistinguishable monitor owns an edit.
            if (matches.length !== 1)
                throw new Error('Layout monitor is ambiguous');

            const [monitorReference, rememberedMonitor] = matches[0];

            // Changing margins needs adaptation, not a new source area
            // applied to every other remembered position on this monitor.
            if (rememberedMonitor.usableWidth !==
                sourceMonitor.usableWidth ||
                rememberedMonitor.usableHeight !==
                sourceMonitor.usableHeight)
                throw new Error('Layout usable area has changed');

            const rememberedPosition =
                rememberedLayout.placements[kind][identity];

            // Compare after resolving snapshot-local monitor references.
            // Authority-only edits still count as changes.
            if (rememberedPosition?.monitor === monitorReference &&
                rememberedPosition.x === position.x &&
                rememberedPosition.y === position.y &&
                rememberedPosition.width === position.width &&
                rememberedPosition.height === position.height &&
                rememberedPosition.authority === authority)
                continue;

            if (!updatedLayout)
                updatedLayout = JSON.parse(JSON.stringify(rememberedLayout));

            updatedLayout.snappedToGrid = snapshot.snappedToGrid ?? false;
            updatedLayout.placements[kind][identity] = {
                ...position,
                monitor: monitorReference,
                authority,
            };
        }

        if (!updatedLayout)
            return;

        // Replace atomically; retain unedited items and the input snapshot.
        this._rememberedLayouts.set(snapshot.key,
            this._freezeSavedValue(updatedLayout));
        this._queueSave();
    }

    // Accept a settled margin adaptation as one layout, including its new
    // usable dimensions. Ordinary reconciliation still protects known positions.
    rememberAdaptedLayout(snapshot) {
        this._rememberLayout(snapshot);
        const rememberedLayout = this.rememberedLayout;
        const updatedLayout = JSON.parse(JSON.stringify(rememberedLayout));
        updatedLayout.snappedToGrid = snapshot.snappedToGrid ?? false;
        const monitorReferences = new Map();

        for (const [reference, monitor] of Object.entries(snapshot.monitors)) {
            const monitorKey = this._createProfileKey('', [monitor]);
            const matches = Object.entries(rememberedLayout.monitors).filter(
                ([, rememberedMonitor]) =>
                    this._createProfileKey('', [rememberedMonitor]) === monitorKey
            );

            if (matches.length !== 1)
                throw new Error('Layout monitor is ambiguous');

            const rememberedReference = matches[0][0];
            monitorReferences.set(reference, rememberedReference);
            updatedLayout.monitors[rememberedReference] = {...monitor};
        }

        for (const kind of ['icons', 'widgets']) {
            for (const [identity, position] of
                Object.entries(snapshot.placements[kind])) {
                updatedLayout.placements[kind][identity] = {
                    ...position,
                    monitor: monitorReferences.get(position.monitor),
                    authority: rememberedLayout.placements[kind][identity]
                        ?.authority ?? 'baseline',
                };
            }
        }

        // Retain absent items and their authority; replace geometry and the
        // observed positions together, after icons and widgets have settled.
        if (JSON.stringify(updatedLayout) === JSON.stringify(rememberedLayout))
            return;

        this._rememberedLayouts.set(snapshot.key,
            this._freezeSavedValue(updatedLayout));
        this._queueSave();
    }

    _rememberLayout(snapshot) {
        if (!snapshot ||
            snapshot.key !== this._currentMonitorConfiguration?.key ||
            snapshot.namespace !== this._namespace)
            throw new Error('Layout does not match the current configuration');

        // Repeated capture must not replace an established arrangement with
        // temporary adaptations. Intentional edits will have their own path.
        if (this._lastActiveProfileKeysByNamespace[this._namespace] !== snapshot.key) {
            this._lastActiveProfileKeysByNamespace[this._namespace] = snapshot.key;
            this._queueSave();
        }

        if (this._rememberedLayouts.has(snapshot.key))
            return;

        const rememberedLayout = JSON.parse(JSON.stringify(snapshot));

        for (const placements of Object.values(rememberedLayout.placements)) {
            for (const placement of Object.values(placements))
                placement.authority = 'baseline';
        }

        this._rememberedLayouts.set(snapshot.key,
            this._freezeSavedValue(rememberedLayout));
        this._sourceLayout = this.rememberedLayout;
        this._clearDestinationMonitorIndices();

        this._queueSave();
    }

    _copyLayoutMonitor(monitor) {
        return {
            width: monitor.width,
            height: monitor.height,
            members: monitor.members.map(member => ({...member})),
        };
    }

    _freezeSavedValue(value) {
        if (value && typeof value === 'object') {
            Object.values(value).forEach(child =>
                this._freezeSavedValue(child));

            Object.freeze(value);
        }

        return value;
    }

    // Profile persistence and lifecycle
    // Load and validate layout files, expose readiness, and queue asynchronous
    // writes. Storage does not decide item placement.

    async waitForProfiles() {
        await this._loadProfilesPromise;

        // Geometry may precede disk loading. Retry physical profile matching
        // now that all remembered configurations are available.
        if (this._currentMonitorConfiguration)
            this._registerCurrentProfile();

        // Resolve the already selected destination against loaded memory.
        // Geometry arriving later selects directly from that same memory.
        const transition = this._profileTransition;

        if (!transition)
            return;

        const destinationLayout = this._rememberedLayouts.get(
            transition.destination.profileKey
        ) ?? null;
        const sourceProfileKey = this._lastActiveProfileKeysByNamespace[
            this._namespace
        ];
        const sourceLayout = sourceProfileKey !==
            transition.destination.profileKey
            ? this._rememberedLayouts.get(sourceProfileKey) : null;
        const source = transition.source ?? (sourceLayout ? Object.freeze({
            profileKey: sourceProfileKey, layout: sourceLayout,
        }) : null);

        if (destinationLayout !== transition.destination.layout ||
            source !== transition.source) {
            this._profileTransition = Object.freeze({
                source,
                destination: Object.freeze({
                    profileKey: transition.destination.profileKey,
                    layout: destinationLayout,
                }),
                requiresTransformation:
                    source !== null && destinationLayout === null,
            });
            this._sourceLayout = destinationLayout ?? source?.layout ?? null;
            this._destinationMonitorIndices = this._sourceLayout
                ? null : new Map();
        }
    }

    stopLayoutManager() {
        this._savePendingProfiles().catch(error => console.error(error,
            'Failed to save layout profiles during shutdown'));
    }

    async _savePendingProfiles() {
        if (this._saveTimeoutId) {
            GLib.source_remove(this._saveTimeoutId);
            this._saveTimeoutId = 0;
        }

        if (!this._savingProfiles) {
            this._savingProfiles = (async () => {
                await this._loadProfilesPromise;
                await this._saveProfiles();
            })().finally(() => {
                this._savingProfiles = null;
            });
        }

        await this._savingProfiles;
    }

    async _initializeProfiles() {
        try {
            await this._loadProfiles();
        } catch (error) {
            console.error(error, 'Failed to load layouts; starting fresh');
            this._queueSave();
        }
    }

    async _loadProfiles() {
        let savedState;

        try {
            savedState = await this._desktopUtilities.readJsonFile(
                this._layoutsStateFile, null, true
            );

            if (savedState === null)
                throw new Error('Invalid layout state');
        } catch (error) {
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                throw error;

            savedState = null;
        }

        const loadedProfiles = this._validateSavedState(savedState);
        let profilesChanged = false;

        // Loaded authority wins on overlap, including future placements.
        // Configurations observed during the read remain in the registry.
        // Do not replace the current snapshot or its active key.
        for (const [profileKey, profile] of this._profiles) {
            if (!loadedProfiles.has(profileKey)) {
                loadedProfiles.set(profileKey, profile);
                profilesChanged = true;
            }
        }

        const hasRuntimeLayouts = this._rememberedLayouts.size > 0;
        this._profiles = loadedProfiles;

        if (savedState?.version === 2) {
            for (const profile of savedState.profiles) {
                // An empty registration is not an adaptation source. Start
                // with no saved arrangement, as when JSON storage is first used.
                if (profile.placements &&
                    Object.keys(profile.monitors).length === 0) {
                    profilesChanged = true;
                    continue;
                }

                if (profile.placements &&
                    !this._rememberedLayouts.has(profile.key)) {
                    this._rememberedLayouts.set(profile.key,
                        this._freezeSavedValue(profile));
                }
            }
        }

        this._lastActiveProfileKeysByNamespace = {
            ...savedState?.lastActiveProfileKeysByNamespace,
            ...this._lastActiveProfileKeysByNamespace,
        };

        for (const [namespace, key] of
            Object.entries(this._lastActiveProfileKeysByNamespace)) {
            if (!this._rememberedLayouts.has(key))
                delete this._lastActiveProfileKeysByNamespace[namespace];
        }

        if (profilesChanged || hasRuntimeLayouts)
            this._queueSave();
        else
            this._pendingSave = null;
    }

    _validateSavedState(savedState) {
        const loadedProfiles = new Map();

        if (savedState === null)
            return loadedProfiles;

        if (![1, 2].includes(savedState.version) ||
            !Array.isArray(savedState.profiles))
            throw new Error('Unsupported or invalid layout state');

        for (const storedProfile of savedState.profiles) {
            const savedProfile = savedState.version === 2
                ? {
                    ...storedProfile,
                    monitors: Object.values(storedProfile.monitors ?? {}),
                }
                : storedProfile;

            if (savedState.version === 2)
                this._validateLayout(storedProfile);

            if (!savedProfile || typeof savedProfile.namespace !== 'string' ||
                !Array.isArray(savedProfile.monitors))
                throw new Error('Invalid saved layout profile');

            for (const logicalMonitor of savedProfile.monitors) {
                if (!logicalMonitor ||
                    !Number.isInteger(logicalMonitor.width) ||
                    !Number.isInteger(logicalMonitor.height) ||
                    logicalMonitor.width <= 0 || logicalMonitor.height <= 0 ||
                    !Array.isArray(logicalMonitor.members))
                    throw new Error('Invalid saved monitor geometry');

                for (const member of logicalMonitor.members) {
                    if (!member || ['connector', 'vendor', 'product', 'serial']
                        .some(field => typeof member[field] !== 'string'))
                        throw new Error('Invalid saved monitor specification');
                }
            }

            const expectedKey = this._createProfileKey(
                savedProfile.namespace, savedProfile.monitors
            );

            if (savedProfile.key !== expectedKey ||
                loadedProfiles.has(expectedKey))
                throw new Error('Invalid or duplicate layout profile key');

            const placements = savedProfile.placements;

            if (placements !== undefined &&
                (!placements || typeof placements !== 'object' ||
                    Array.isArray(placements)))
                throw new Error('Invalid saved placements');

            loadedProfiles.set(expectedKey, this._freezeSavedValue({
                ...savedProfile, placements: placements ?? {},
            }));
        }

        const activeKeys = savedState.lastActiveProfileKeysByNamespace;

        if (!activeKeys || typeof activeKeys !== 'object' ||
            Array.isArray(activeKeys))
            throw new Error('Invalid last-active profile keys');

        for (const [namespace, profileKey] of Object.entries(activeKeys)) {
            const profile = loadedProfiles.get(profileKey);

            if (profile?.namespace !== namespace || !profile.placements?.icons)
                throw new Error('Invalid last-active profile reference');
        }

        return loadedProfiles;
    }

    _validateLayout(profile) {
        if (!profile || !profile.monitors ||
            typeof profile.monitors !== 'object' ||
            Array.isArray(profile.monitors))
            throw new Error('Invalid layout monitors');

        if (profile.placements === undefined)
            return;

        if (profile.snappedToGrid !== undefined &&
            typeof profile.snappedToGrid !== 'boolean')
            throw new Error('Invalid saved placement mode');

        for (const monitor of Object.values(profile.monitors)) {
            if (!Number.isFinite(monitor?.usableWidth) ||
                !Number.isFinite(monitor?.usableHeight) ||
                monitor.usableWidth <= 0 || monitor.usableHeight <= 0)
                throw new Error('Invalid layout usable dimensions');

            if (monitor.grid !== undefined &&
                (!Number.isInteger(monitor.grid?.columnCount) ||
                    !Number.isInteger(monitor.grid?.rowCount) ||
                    monitor.grid.columnCount < 0 || monitor.grid.rowCount < 0))
                throw new Error('Invalid saved grid dimensions');
        }

        for (const kind of ['icons', 'widgets']) {
            const placements = profile.placements?.[kind];

            if (!placements || typeof placements !== 'object' ||
                Array.isArray(placements))
                throw new Error('Invalid layout placements');

            for (const position of Object.values(placements)) {
                const monitor = Object.hasOwn(
                    profile.monitors, position?.monitor
                ) ? profile.monitors[position.monitor] : null;

                if (!monitor || !Number.isFinite(position.x) ||
                    !Number.isFinite(position.y) ||
                    !['baseline', 'user', 'established']
                        .includes(position.authority))
                    throw new Error('Invalid layout position');

                if (kind === 'widgets' &&
                    (!Number.isFinite(position.width) ||
                        !Number.isFinite(position.height) ||
                        position.width <= 0 || position.height <= 0))
                    throw new Error('Invalid widget dimensions');
            }
        }
    }

    _queueSave() {
        // Keep the latest request, as in the widget-state writer.
        this._pendingSave = {profiles: this._profiles};

        if (this._savingProfiles || this._saveTimeoutId)
            return;

        // One timer per burst; writes stay outside the desktop serializer.
        this._saveTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 500, () => {
                this._saveTimeoutId = 0;
                this._savePendingProfiles().catch(error => console.error(error,
                    'Failed to save layout profiles'));
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    async _saveProfiles() {
        while (this._pendingSave) {
            const pendingSave = this._pendingSave;

            const savedState = {
                version: 2,
                // Namespace -> last settled profile key table.
                lastActiveProfileKeysByNamespace:
                    {...this._lastActiveProfileKeysByNamespace},
                profiles: Array.from(
                    pendingSave.profiles.values(), profile =>
                        this._rememberedLayouts.get(profile.key) ?? {
                            key: profile.key,
                            namespace: profile.namespace,
                            monitors: Object.fromEntries(
                                profile.monitors.map((monitor, index) =>
                                    [`m${index}`,
                                        this._copyLayoutMonitor(monitor)])
                            ),
                        }
                ),
            };

            // Profiles are immutable. A complete snapshot retains placement
            // data and cannot change underneath the asynchronous writer.
            // eslint-disable-next-line no-await-in-loop
            await this._desktopUtilities.writeJsonFile(
                this._layoutsStateFile, savedState
            );

            // Clear only the request that completed. A newer request remains
            // queued. Failed writes retain the latest request for retry.
            if (this._pendingSave === pendingSave)
                this._pendingSave = null;
        }
    }

    // Exact restoration
    // Resolve remembered surfaces and positions without selecting a new layout.

    createRestorePlan(desktops) {
        const rememberedLayout = this.rememberedLayout;

        if (!rememberedLayout)
            return null;

        const monitorIndices = this.sourceMonitorIndices;
        const monitorDestinations = new Map();
        const unresolvedMonitors = [];

        for (const [reference, savedMonitor] of
            Object.entries(rememberedLayout.monitors)) {
            const desktop = desktops.find(surface =>
                surface.monitorIndex === monitorIndices.get(reference));

            // Changed margins need a separate adaptation policy. Do not claim
            // exact restoration when the original usable area is unavailable.
            if (!desktop ||
                desktop.normalizedWidth !== savedMonitor.usableWidth ||
                desktop.normalizedHeight !== savedMonitor.usableHeight) {
                unresolvedMonitors.push(reference);
                continue;
            }

            monitorDestinations.set(reference, desktop.monitorIndex);
        }

        const icons = {};
        const widgets = {};

        for (const [kind, destination] of Object.entries({icons, widgets})) {
            for (const [identity, placement] of
                Object.entries(rememberedLayout.placements[kind])) {
                const monitorIndex =
                    monitorDestinations.get(placement.monitor);

                if (monitorIndex === undefined)
                    continue;

                const frame = {monitorIndex, x: placement.x, y: placement.y};

                if (kind === 'widgets') {
                    frame.width = placement.width;
                    frame.height = placement.height;
                }

                destination[identity] = frame;
            }
        }

        // Only the plan uses live indices. Remembered positions stay intact.
        return {icons, widgets, unresolvedMonitors};
    }

    // Consume incoming coordinates into profile memory before any display
    // mode changes the item. Duplicate destinations are resolved on placement.
    recordDropPositions(fileList, desktops) {
        const droppedFiles = fileList.filter(item =>
            item.dropCoordinates != null);

        if (!droppedFiles.length)
            return;

        const positions = droppedFiles.map(item => {
            const [x, y] = item.dropCoordinates;
            const desktop = desktops.find(surface =>
                surface.coordinatesBelongToThisGridWindow(x, y));

            if (!desktop)
                throw new Error('Drop destination has no desktop surface');

            return {
                uri: item.uri, savedCoordinates: [x, y],
                _monitorIndex: desktop.monitorIndex,
            };
        });
        const snapshot = this.captureLayout(desktops, {}, positions);

        if (!snapshot)
            return;

        this.reconcileLayout(snapshot, droppedFiles.map(item => item.uri));

        for (const item of droppedFiles) {
            item.savedCoordinates = null;
            item.dropCoordinates = null;
            item.pendingPlacementReason = 'user-drop';
        }
    }

    applyRememberedIconPositions(fileList, desktops) {
        const plan = this.createRestorePlan(desktops);

        if (!plan)
            return;

        for (const fileItem of fileList) {
            const position = plan.icons[fileItem.uri];

            // An explicit incoming destination takes priority over memory.
            // Unknown items and unresolved surfaces keep the existing path.
            if (!position || fileItem.dropCoordinates != null)
                continue;

            const desktop = desktops.find(surface =>
                surface.monitorIndex === position.monitorIndex);

            const [globalX, globalY] = desktop.coordinatesLocalToGlobal(
                position.x, position.y
            );

            const [normalizedX, normalizedY] = desktop.getNormalizedCoordinates(
                position.x, position.y
            );

            fileItem.savedCoordinates = [
                globalX, globalY, normalizedX, normalizedY,
                position.monitorIndex,
            ];
        }
    }

    // Apply resolved icon positions in file order. Actor removal and display
    // mode changes remain the caller's responsibility.
    restoreIconPlacements(fileList, desktops, iconPositions) {
        for (const fileItem of fileList) {
            const position = iconPositions[fileItem.uri];

            if (!position)
                continue;

            const desktop = desktops.find(surface =>
                surface.monitorIndex === position.monitorIndex);

            this._restoreIconPlacement(
                fileItem, desktop, position.x, position.y
            );
        }
    }

    _restoreIconPlacement(fileItem, desktop, localX, localY) {
        if (!this._gridGeometries.has(desktop.index))
            return;

        const placement = this._calculateRestoredIconPlacement(
            desktop.index, localX, localY, desktop.elementSpacing
        );
        const [globalX, globalY] = desktop.coordinatesLocalToGlobal(
            localX, localY
        );

        const applied = desktop.applyIconPlacement(fileItem, {
            ...placement, globalX, globalY,
            cell: {column: placement.column, row: placement.row},
        });

        if (applied) {
            this._reserveIconPlacement(fileItem, desktop, {
                ...placement, globalX, globalY,
            });
        }
    }

    _calculateRestoredIconPlacement(gridIndex, x, y, spacing) {
        const {cellWidth, cellHeight} = this.getGridGeometry(gridIndex);
        const [column, row] = this.getCellAtPosition(gridIndex, x, y);

        // Exact restoration neither snaps nor clamps remembered coordinates.
        return {
            localX: x,
            localY: y,
            width: cellWidth - 2 * spacing,
            height: cellHeight - 2 * spacing,
            spacing,
            column,
            row,
        };
    }

    // Shared grid geometry
    // Register usable surface geometry and provide coordinate and cell arithmetic.
    // These services do not choose placement order or search policy.

    updateGridGeometry(gridIndex, surfaceMeasurements) {
        // Runtime surface indices identify live grids, never saved profiles.
        const gridGeometry = Object.freeze(
            this._calculateGridDimensions(surfaceMeasurements)
        );

        this._gridGeometries.set(gridIndex, gridGeometry);
    }

    getGridGeometry(gridIndex) {
        return this._gridGeometries.get(gridIndex);
    }

    removeGridGeometry(gridIndex) {
        this._gridGeometries.delete(gridIndex);
        this._gridOccupancy.delete(gridIndex);
    }

    getCellAtPosition(gridIndex, localX, localY) {
        const {width, height, columnCount, rowCount, cellWidth, cellHeight} =
            this.getGridGeometry(gridIndex);

        // Invert floor(extent * cell / count), including remainder pixels.
        // The greatest cell origin <= position owns that position. Using the
        // rounded cell width instead accumulates error across later columns.
        const requestedColumn = width > 0 && columnCount > 0 &&
            Number.isFinite(columnCount)
            ? Math.ceil((Math.floor(localX) + 1) * columnCount / width) - 1
            : Math.floor(localX / cellWidth);
        const requestedRow = height > 0 && rowCount > 0 &&
            Number.isFinite(rowCount)
            ? Math.ceil((Math.floor(localY) + 1) * rowCount / height) - 1
            : Math.floor(localY / cellHeight);

        // Same clamp order as DesktopIconsUtil.clamp, even for empty grids.
        const column = Math.max(Math.min(requestedColumn, columnCount - 1), 0);
        const row = Math.max(Math.min(requestedRow, rowCount - 1), 0);

        return [column, row];
    }

    getCellLocalPosition(gridIndex, column, row) {
        const {width, height, columnCount, rowCount} =
            this.getGridGeometry(gridIndex);

        // Use the full extent instead of rounded cell size, preserving the
        // existing distribution of remainder pixels. All arithmetic is O(1).
        const localX = Math.floor(width * column / columnCount);
        const localY = Math.floor(height * row / rowCount);

        return [localX, localY];
    }

    snapDragPosition(gridIndex, localX, localY) {
        const {cellWidth, cellHeight} = this.getGridGeometry(gridIndex);

        // Drag previews use rounded cell sizes without clamping. Placement
        // uses its existing bounds checks separately.
        return [
            cellWidth * Math.floor(localX / cellWidth),
            cellHeight * Math.floor(localY / cellHeight),
        ];
    }

    _calculateGridDimensions({
        width, height, scaleDivisor,
        marginTop, marginBottom, marginLeft, marginRight,
        desiredCellWidth, desiredCellHeight, spacing,
    }) {
        // Inputs are the usable extents and margins before DesktopGrid's
        // scaling step. Preserve each floor operation and its original order.
        const scaledWidth = Math.floor(width / scaleDivisor);
        const scaledHeight = Math.floor(height / scaleDivisor);
        const scaledMarginTop = Math.floor(marginTop / scaleDivisor);
        const scaledMarginBottom = Math.floor(marginBottom / scaleDivisor);
        const scaledMarginLeft = Math.floor(marginLeft / scaleDivisor);
        const scaledMarginRight = Math.floor(marginRight / scaleDivisor);

        // Preserve the existing floor-based grid calculation, including its
        // zero-capacity behavior. This extraction adds no minimum cell count.
        const columnCount =
            Math.floor(scaledWidth / (desiredCellWidth + 4 * spacing));

        const rowCount =
            Math.floor(scaledHeight / (desiredCellHeight + 4 * spacing));

        return {
            width: scaledWidth,
            height: scaledHeight,
            marginTop: scaledMarginTop,
            marginBottom: scaledMarginBottom,
            marginLeft: scaledMarginLeft,
            marginRight: scaledMarginRight,
            columnCount,
            rowCount,
            cellWidth: Math.floor(scaledWidth / columnCount),
            cellHeight: Math.floor(scaledHeight / rowCount),
        };
    }

    _getItemOverlapCorner(gridIndex, globalX, globalY) {
        const {cellWidth, cellHeight} = this.getGridGeometry(gridIndex);

        // Preserve the original two-pixel inset before widget conversion.
        return [globalX + cellWidth - 2, globalY + cellHeight - 2];
    }

    // Shared grid occupancy
    // Own live cell reservations, overlaps and removal. Rendering does not
    // reserve cells; hit testing queries the same reservations.

    resetGridOccupancy(gridIndex) {
        const {columnCount, rowCount} = this.getGridGeometry(gridIndex);
        const occupiedCells = new Map();

        for (let row = 0; row < rowCount; row++) {
            for (let column = 0; column < columnCount; column++)
                occupiedCells.set(row * columnCount + column, new Set());
        }

        this._gridOccupancy.set(gridIndex, occupiedCells);
    }

    isCellEmpty(gridIndex, column, row) {
        return this._getCellItems(gridIndex, column, row).size === 0;
    }

    getItemAtCell(gridIndex, column, row) {
        const cellItems = this._getCellItems(gridIndex, column, row);

        for (const item of cellItems)
            return item;

        return null;
    }

    removeItemFromGrid(gridIndex, item) {
        this._gridOccupancy.get(gridIndex).forEach(cellItems =>
            cellItems.delete(item));
    }

    _hasAvailableCell(gridIndex) {
        const occupiedCells = this._gridOccupancy.get(gridIndex);

        // Removed surfaces cannot participate in monitor selection.
        if (!occupiedCells)
            return false;

        for (const cellItems of occupiedCells.values()) {
            if (!cellItems.size)
                return true;
        }

        return false;
    }

    _reserveIconPlacement(fileItem, desktop, placement) {
        const {column, row, globalX, globalY, snappedToGrid} = placement;
        const gridIndex = desktop.index;
        this._occupyCell(gridIndex, column, row, fileItem);

        if (snappedToGrid)
            return;

        // Preserve the original global-to-local conversion and inset for
        // free placement and exact restoration, including their rounding.
        const [cornerGlobalX, cornerGlobalY] = this._getItemOverlapCorner(
            gridIndex, globalX, globalY
        );
        const [cornerLocalX, cornerLocalY] = desktop.coordinatesGlobalToLocal(
            cornerGlobalX, cornerGlobalY
        );
        const [bottomRightColumn, bottomRightRow] = this.getCellAtPosition(
            gridIndex, cornerLocalX, cornerLocalY
        );
        this._occupyOverlappingCells(
            gridIndex, fileItem, column, row, bottomRightColumn, bottomRightRow
        );
    }

    _occupyCell(gridIndex, column, row, item) {
        this._getCellItems(gridIndex, column, row).add(item);
    }

    _occupyOverlappingCells(gridIndex, item, column, row,
        bottomRightColumn, bottomRightRow) {
        // Extend the already occupied origin cell using the original corner
        // bookkeeping. Preserve gaps and the original insertion order.
        if (bottomRightColumn !== column && bottomRightRow !== row) {
            this._occupyCell(gridIndex, bottomRightColumn,
                bottomRightRow, item);
            this._occupyCell(gridIndex, column, bottomRightRow, item);
            this._occupyCell(gridIndex, bottomRightColumn, row, item);

            return;
        }

        if (bottomRightColumn === column && bottomRightRow !== row) {
            this._occupyCell(gridIndex, column, bottomRightRow, item);

            return;
        }

        if (bottomRightColumn !== column && bottomRightRow === row)
            this._occupyCell(gridIndex, bottomRightColumn, row, item);
    }

    _getCellItems(gridIndex, column, row) {
        const {columnCount} = this.getGridGeometry(gridIndex);
        return this._gridOccupancy.get(gridIndex)
            .get(row * columnCount + column);
    }

    // Arrangement and sorting
    // Order and group files for the existing arrangement commands.

    // Return the ordered list, or null when this mode requests no sorting.
    // Kind grouping creates a list; the other orders sort the input in place.
    orderFiles(fileList, sortOrder, sortOrders) {
        switch (sortOrder) {
        case sortOrders.NAME:
            this._sortFilesByName(fileList);
            break;
        case sortOrders.DESCENDINGNAME:
            this._sortFilesByName(fileList);
            fileList.reverse();
            break;
        case sortOrders.MODIFIEDTIME:
            this._sortFilesByModifiedTime(fileList);
            break;
        case sortOrders.KIND:
            return this._groupAndSortFilesByKind(fileList);
        case sortOrders.SIZE:
            this._sortFilesBySize(fileList);
            break;
        default:
            return null;
        }

        return fileList;
    }

    _sortFilesByCurrentPosition(fileList, startCorner) {
        const cornerInversion = startCorner;

        if (!cornerInversion[0] && !cornerInversion[1]) {
            fileList.sort((firstFile, secondFile) => {
                if (firstFile.x < secondFile.x)
                    return -1;

                if (firstFile.x > secondFile.x)
                    return 1;

                if (firstFile.y < secondFile.y)
                    return -1;

                if (firstFile.y > secondFile.y)
                    return 1;

                return 0;
            });
        }

        if (cornerInversion[0] && cornerInversion[1]) {
            fileList.sort((firstFile, secondFile) => {
                if (firstFile.x < secondFile.x)
                    return 1;

                if (firstFile.x > secondFile.x)
                    return -1;

                if (firstFile.y < secondFile.y)
                    return 1;

                if (firstFile.y > secondFile.y)
                    return -1;

                return 0;
            });
        }

        if (cornerInversion[0] && !cornerInversion[1]) {
            fileList.sort((firstFile, secondFile) => {
                if (firstFile.x < secondFile.x)
                    return 1;

                if (firstFile.x > secondFile.x)
                    return -1;

                if (firstFile.y < secondFile.y)
                    return -1;

                if (firstFile.y > secondFile.y)
                    return 1;

                return 0;
            });
        }

        if (!cornerInversion[0] && cornerInversion[1]) {
            fileList.sort((firstFile, secondFile) => {
                if (firstFile.x < secondFile.x)
                    return -1;

                if (firstFile.x > secondFile.x)
                    return 1;

                if (firstFile.y < secondFile.y)
                    return 1;

                if (firstFile.y > secondFile.y)
                    return -1;

                return 0;
            });
        }
    }

    _groupAndSortFilesByKind(fileList) {
        const specialFiles = [];
        const directoryFiles = [];
        const desktopLauncherFiles = [];
        const otherFiles = [];

        for (const fileItem of fileList) {
            if (fileItem._isSpecial) {
                specialFiles.push(fileItem);
                continue;
            }

            if (fileItem._isDirectory) {
                directoryFiles.push(fileItem);
                continue;
            }

            if (fileItem._isValidDesktopFile) {
                desktopLauncherFiles.push(fileItem);
                continue;
            }

            otherFiles.push(fileItem);
        }

        this._sortFilesByName(specialFiles);
        this._sortFilesByName(directoryFiles);
        this._sortFilesByName(desktopLauncherFiles);
        this._sortFilesByKindThenName(otherFiles);

        return [
            ...specialFiles,
            ...desktopLauncherFiles,
            ...directoryFiles,
            ...otherFiles,
        ];
    }

    _sortFilesByName(fileList) {
        /**
         * @param {string} firstFile fileItem filename for A
         * @param {string} secondFile fileItem filename for B
         */
        function byName(firstFile, secondFile) {
            // sort by label name instead of the the fileName or displayName so
            // that the "Home" folder is sorted in the correct order
            // alphabetical sort taking into account accent characters &
            // locale, natural language sort for numbers.
            // other options for locale are best fit, or by specifying directly
            // in function below for translators
            return firstFile.labelText
                .localeCompare(
                    secondFile.labelText,
                    {
                        sensitivity: 'accent',
                        numeric: 'true',
                        localeMatcher: 'lookup',
                    }
                );
        }
        fileList.sort(byName);
    }

    _sortFilesByKindThenName(fileList) {
        /**
         * Sort by Kind, then by name
         *
         * @param {string} firstFile fileItem
         * @param {string} secondFile fileItem
         */
        function byKindByName(firstFile, secondFile) {
            return (
                firstFile.attributeContentType
                    .localeCompare(secondFile.attributeContentType) ||
                firstFile.labelText
                    .localeCompare(
                        secondFile.labelText,
                        {
                            sensitivity: 'accent',
                            numeric: 'true',
                            localeMatcher: 'lookup',
                        }
                    )
            );
        }
        fileList.sort(byKindByName);
    }

    _sortFilesByOriginalPosition(fileList, startCorner) {
        const cornerInversion = startCorner;

        if (!cornerInversion[0] && !cornerInversion[1]) {
            fileList.sort((firstFile, secondFile) => {
                if (firstFile.X < secondFile.X)
                    return -1;

                if (firstFile.X > secondFile.X)
                    return 1;

                if (firstFile.Y < secondFile.Y)
                    return -1;

                if (firstFile.Y > secondFile.Y)
                    return 1;

                return 0;
            });
        }

        if (cornerInversion[0] && cornerInversion[1]) {
            fileList.sort((firstFile, secondFile) => {
                if (firstFile.X < secondFile.X)
                    return 1;

                if (firstFile.X > secondFile.X)
                    return -1;

                if (firstFile.Y < secondFile.Y)
                    return 1;

                if (firstFile.Y > secondFile.Y)
                    return -1;

                return 0;
            });
        }

        if (cornerInversion[0] && !cornerInversion[1]) {
            fileList.sort((firstFile, secondFile) => {
                if (firstFile.X < secondFile.X)
                    return 1;

                if (firstFile.X > secondFile.X)
                    return -1;

                if (firstFile.Y < secondFile.Y)
                    return -1;

                if (firstFile.Y > secondFile.Y)
                    return 1;

                return 0;
            });
        }

        if (!cornerInversion[0] && cornerInversion[1]) {
            fileList.sort((firstFile, secondFile) => {
                if (firstFile.X < secondFile.X)
                    return -1;

                if (firstFile.X > secondFile.X)
                    return 1;

                if (firstFile.Y < secondFile.Y)
                    return 1;

                if (firstFile.Y > secondFile.Y)
                    return -1;

                return 0;
            });
        }
    }

    _sortFilesByModifiedTime(fileList) {
        fileList.sort((firstFile, secondFile) =>
            firstFile._modifiedTime - secondFile._modifiedTime
        );
    }

    _sortFilesBySize(fileList) {
        fileList.sort((firstFile, secondFile) =>
            firstFile.fileSize - secondFile.fileSize
        );
    }

    // Stacking and original positions
    // Build the stack presentation while retaining individual original positions
    // for capture, explicit edits and unstacking.

    groupFilesForStacking(fileList) {
        const specialFiles = [];
        const directoryFiles = [];
        const validDesktopFiles = [];
        const otherFiles = [];
        const stackedFiles = [];

        this._sortFilesByName(fileList);

        for (const fileItem of fileList) {
            if (fileItem.isSpecial) {
                specialFiles.push(fileItem);
                continue;
            }

            if (fileItem.isDirectory) {
                directoryFiles.push(fileItem);
                continue;
            }

            if (fileItem._isValidDesktopFile) {
                validDesktopFiles.push(fileItem);
                continue;
            } else {
                const contentType = fileItem.attributeContentType;
                let hasRepresentative = false;

                for (const representativeFile of otherFiles) {
                    if (contentType ===
                        representativeFile.attributeContentType) {
                        stackedFiles.push(fileItem);
                        hasRepresentative = true;
                    }
                }

                if (!hasRepresentative) {
                    fileItem.isStackTop = true;
                    otherFiles.push(fileItem);
                }

                continue;
            }
        }

        for (const representativeFile of otherFiles) {
            let hasStackMembers = false;

            for (const stackedFile of stackedFiles) {
                if (stackedFile.attributeContentType ===
                    representativeFile.attributeContentType) {
                    hasStackMembers = true;
                    break;
                }
            }

            if (!hasStackMembers)
                representativeFile.stackUnique = true;

            continue;
        }

        // Non-unique representatives belong to their own stacks too. The
        // caller creates marker actors; membership is complete before that.
        for (const representativeFile of otherFiles) {
            if (!representativeFile.stackUnique) {
                representativeFile.isStackTop = false;
                stackedFiles.push(representativeFile);
            }
        }

        return {
            specialFiles, directoryFiles, validDesktopFiles,
            otherFiles, stackedFiles,
        };
    }

    orderStackedFiles(stackGroups, stackTopMarkerFolderList,
        unstackList, sortOrder, sortOrders) {
        const {
            specialFiles, directoryFiles, validDesktopFiles, stackedFiles,
        } = stackGroups;

        function updateMarkerSortAttributes() {
            for (const visibleFile of otherFiles) {
                if (visibleFile.isStackMarker) {
                    for (const stackMember of stackedFiles) {
                        if (visibleFile.attributeContentType ===
                            stackMember.attributeContentType) {
                            visibleFile.size = stackMember.fileSize;
                            visibleFile.time = stackMember.modifiedTime;
                            break;
                        }
                    }
                }
            }
        }

        const otherFiles = [];
        const orderedFiles = [];
        this._sortFilesByName(specialFiles);
        this._sortFilesByName(directoryFiles);
        this._sortFilesByName(validDesktopFiles);
        this._sortFilesByKindThenName(stackedFiles);
        this._sortFilesByKindThenName(stackTopMarkerFolderList);
        otherFiles.push(...specialFiles);
        otherFiles.push(...validDesktopFiles);
        otherFiles.push(...directoryFiles);
        otherFiles.push(...stackTopMarkerFolderList);

        switch (sortOrder) {
        case sortOrders.NAME:
            this._sortFilesByName(otherFiles);
            break;
        case sortOrders.DESCENDINGNAME:
            this._sortFilesByName(otherFiles);
            otherFiles.reverse();
            this._sortFilesByName(stackedFiles);
            stackedFiles.reverse();
            break;
        case sortOrders.MODIFIEDTIME:
            this._sortFilesByModifiedTime(stackedFiles);
            updateMarkerSortAttributes();
            this._sortFilesByModifiedTime(otherFiles);
            break;
        case sortOrders.KIND:
            break;
        case sortOrders.SIZE:
            this._sortFilesBySize(stackedFiles);
            updateMarkerSortAttributes();
            this._sortFilesBySize(otherFiles);
            break;
        default:
            break;
        }

        for (const visibleFile of otherFiles) {
            orderedFiles.push(visibleFile);
            const contentType = visibleFile.attributeContentType;

            for (const stackMember of stackedFiles) {
                if (unstackList.includes(stackMember.attributeContentType) &&
                    (stackMember.attributeContentType === contentType))
                    orderedFiles.push(stackMember);
            }
        }

        return orderedFiles;
    }

    // Placement requests
    // Select stages once from the triggering reason, memory and current grids.
    // The pipeline consumes these flags without selecting more work.

    // Prepared request shape:
    // {
    //     geometryTransition, sourceLayout,
    //     sourceMonitorIndices: Map<savedMonitorReference, currentIndex>,
    //     operationFlags: {
    //         ...triggeringReason,
    //         restorePositions: boolean,
    //         applyAffine: boolean,
    //         applyWebCola: boolean,
    //         applyHungarian: boolean,
    //     },
    // }
    // Called before display mutation, once profile and current grids are known.
    // Each optional stage reads its preset flag; sequential placement is last.
    selectLayoutAdaptations(layoutRequest, desktops, preferences) {
        const {operationFlags = {}, geometryTransition} = layoutRequest;
        const currentProfileLayout = this.rememberedLayout;

        const layoutRequested = Boolean(operationFlags.initialRead ||
            operationFlags.redisplay || operationFlags.monitorschanged ||
            operationFlags.gridschanged || operationFlags.marginsChanged ||
            operationFlags.snapToGrid ||
            operationFlags.iconSizeChanged || operationFlags.unstack);

        const adaptRememberedLayoutForMargins = Boolean(
            operationFlags.marginsChanged &&
            currentProfileLayout &&
            !geometryTransition.changes.profileChanged
        );

        const unseenDestination =
            layoutRequested &&
            !currentProfileLayout &&
            this.profileTransition.requiresTransformation;

        // Margin and icon-size changes start from the current profile's
        // remembered positions. An unseen destination uses the previous
        // active profile instead. Resolve it from memory for the latest edits.
        const previousActiveProfileLayout = this._rememberedLayouts.get(
            this.profileTransition.source?.profileKey
        );

        const sourceLayout = unseenDestination
            ? previousActiveProfileLayout
            : currentProfileLayout;

        if (this._sourceLayout !== sourceLayout) {
            this._sourceLayout = sourceLayout;
            this._destinationMonitorIndices = sourceLayout ? null : new Map();
        }

        const layoutNeeded = layoutRequested &&
            (!preferences.keepArranged || preferences.keepStacked);

        const savedLayoutMatchesTargetGrid = layoutNeeded
            ? this._savedLayoutMatchesTargetGrid(currentProfileLayout, desktops)
            : false;

        // An old destination profile may have different saved margins even
        // though this update did not report a live margin change. Its saved
        // coordinates must be mapped before refinement, not exactly restored.
        const adaptSavedLayoutToTargetArea = Boolean(
            layoutNeeded &&
            currentProfileLayout &&
            !operationFlags.snapToGrid &&
            !savedLayoutMatchesTargetGrid &&
            !this._savedLayoutMatchesTargetUsableArea(
                currentProfileLayout, desktops
            )
        );

        const applyAffine = Boolean(
            layoutNeeded &&
            sourceLayout &&
            (unseenDestination || adaptRememberedLayoutForMargins ||
                adaptSavedLayoutToTargetArea)
        );

        const applyWebCola = Boolean(
            layoutNeeded &&
            sourceLayout &&
            (
                unseenDestination ||
                operationFlags.iconSizeChanged ||
                !savedLayoutMatchesTargetGrid
            )
        );

        const applyHungarian = Boolean(
            layoutNeeded &&
            !preferences.freePositionIcons &&
            (
                operationFlags.snapToGrid ||
                operationFlags.iconSizeChanged ||
                !currentProfileLayout?.snappedToGrid ||
                !savedLayoutMatchesTargetGrid
            )
        );

        return {
            ...layoutRequest,
            sourceLayout,
            sourceMonitorIndices: sourceLayout
                ? this.sourceMonitorIndices : new Map(),
            operationFlags: {
                ...operationFlags,
                restorePositions: layoutRequested && !applyAffine &&
                    !operationFlags.snapToGrid,
                applyAffine, applyWebCola, applyHungarian,
            },
        };
    }

    // Does this saved layout already fit the target usable area and grid?
    // WindowManager classifies live changes; this checks the profile on disk
    // or in memory. Missing or ambiguous saved geometry is not an exact match.
    _savedLayoutMatchesTargetGrid(rememberedLayout, desktops) {
        if (!rememberedLayout)
            return false;

        for (const desktop of desktops) {
            const savedMonitor = this._getSavedMonitorForDesktop(
                rememberedLayout, desktop
            );

            if (!savedMonitor)
                return false;

            const grid = this.getGridGeometry(desktop.index);

            if (savedMonitor.usableWidth !== desktop.normalizedWidth ||
                savedMonitor.usableHeight !== desktop.normalizedHeight ||
                !savedMonitor.grid ||
                savedMonitor.grid.columnCount !== grid.columnCount ||
                savedMonitor.grid.rowCount !== grid.rowCount)
                return false;
        }

        return true;
    }

    // Cell-count changes need reassignment; usable-area changes additionally
    // need affine mapping of the saved positions. Keep those decisions apart.
    _savedLayoutMatchesTargetUsableArea(rememberedLayout, desktops) {
        for (const desktop of desktops) {
            const savedMonitor = this._getSavedMonitorForDesktop(
                rememberedLayout, desktop
            );

            if (!savedMonitor ||
                savedMonitor.usableWidth !== desktop.normalizedWidth ||
                savedMonitor.usableHeight !== desktop.normalizedHeight)
                return false;
        }

        return true;
    }

    _getSavedMonitorForDesktop(rememberedLayout, desktop) {
        const monitorIndices = this.sourceMonitorIndices;
        const savedMonitor = Object.entries(rememberedLayout.monitors).find(
            ([reference]) =>
                monitorIndices.get(reference) === desktop.monitorIndex
        );

        return savedMonitor?.[1] ?? null;
    }

    // Geometry transformation
    // Shared monitor correspondence and icon/widget affine mapping.
    // Adapt icons before sequential placement; widgets retain their size.
    // Geometry is available through placementContext.geometryTransition;
    // Seed normalized coordinates from the selected source arrangement.
    // Existing coordinate conversion and live grid-cell mapping follow.

    // Widget adaptation is affine only: retain dimensions and map saved local
    // positions through their source usable area into the target usable area.
    // Negative/off-grid coordinates are valid for pinned widgets; do not clamp.
    createWidgetAffinePlacements(desktops,
        sourceLayout = this.rememberedLayout ?? this._rememberedLayouts.get(
            this.profileTransition.source?.profileKey
        ), sourceMonitorIndices = null) {
        if (!sourceLayout)
            return {};

        const selectedSourceLayout = this.rememberedLayout ??
            this._rememberedLayouts.get(this.profileTransition.source?.profileKey);

        if (sourceLayout !== selectedSourceLayout &&
            sourceMonitorIndices === null) {
            throw new Error(
                'Widget source layout requires its own monitor indices'
            );
        }

        const monitorIndices = sourceMonitorIndices ?? this.sourceMonitorIndices;

        // No identity data is needed for one unambiguous source/target pair.
        const fallbackDesktop =
            Object.keys(sourceLayout.monitors).length === 1 &&
            desktops.length === 1 ? desktops[0] : null;

        const placements = {};

        for (const [identity, position] of
            Object.entries(sourceLayout.placements.widgets)) {
            const monitorIndex = monitorIndices.get(position.monitor);
            const desktop = desktops.find(surface =>
                surface.monitorIndex === monitorIndex) ?? fallbackDesktop;

            if (!desktop)
                continue;

            const sourceMonitor = sourceLayout.monitors[position.monitor];
            placements[identity] = {
                monitorIndex: desktop.monitorIndex,
                x: position.x / sourceMonitor.usableWidth *
                    desktop.normalizedWidth,
                y: position.y / sourceMonitor.usableHeight *
                    desktop.normalizedHeight,
                width: position.width,
                height: position.height,
            };
        }

        return placements;
    }

    // Prepare individual coordinates without rendering hidden stack members.
    // The returned records belong only to this update's final snapshot.
    prepareStackedIconPositions(fileList, placementContext) {
        const {desktops, primaryMonitorIndex, preferences} = placementContext;
        const preferredDesktop = this.getPreferredDesktop(
            desktops, primaryMonitorIndex, preferences.showOnSecondaryMonitor
        );

        for (const fileItem of fileList)
            fileItem.savedCoordinates = null;

        this._adaptIconPositions(fileList, placementContext, preferredDesktop);

        // Incoming destinations were recorded on the target before adaptation.
        // They override source-profile seeds, including on an unseen surface.
        const droppedFiles = fileList.filter(fileItem =>
            fileItem.pendingPlacementReason === 'user-drop'
        );

        if (droppedFiles.length)
            this.applyRememberedIconPositions(droppedFiles, desktops);

        return fileList.filter(fileItem =>
            fileItem.savedCoordinates !== null
        ).map(fileItem => ({
            uri: fileItem.uri,
            savedCoordinates: [...fileItem.savedCoordinates],
            _monitorIndex: fileItem._monitorIndex,
        }));
    }

    // Normal and stacked layouts use the same selected coordinate stages.
    // Sequential placement and stack presentation happen after this method.
    _adaptIconPositions(fileList, placementContext, preferredDesktop) {
        const {desktops, preferences, operationFlags = {}} = placementContext;

        // The request selected these stages before display mutation began.
        if (operationFlags.restorePositions)
            this.applyRememberedIconPositions(fileList, desktops);

        if (operationFlags.applyAffine) {
            this._transformLayout(fileList, placementContext.sourceLayout,
                placementContext, preferredDesktop);
        }

        if (operationFlags.applyWebCola) {
            this._refineAffineLayout(fileList, placementContext.sourceLayout,
                desktops, preferences);
        }

        if (operationFlags.applyHungarian)
            this._snapFilePositionsToGrid(fileList, desktops);
    }

    _transformLayout(fileList, sourceLayout, placementContext,
        preferredDesktop) {
        const {desktops, preferences} = placementContext;
        this._normalizeSourceIconCoordinates(
            fileList, sourceLayout, placementContext.sourceMonitorIndices,
            preferredDesktop
        );
        this._sortFilesByCurrentPosition(fileList, preferences.startCorner);
        this._recomputeWindowPositions(fileList, desktops, preferredDesktop);
    }

    // Profile selection refreshes correspondence when live monitors change.
    // A new destination clears it so the getter can map its selected source.
    _clearDestinationMonitorIndices() {
        this._destinationMonitorIndices = null;
    }

    // Resolve saved monitor references to current indices before normalization.
    _resolveSourceMonitorIndices(sourceLayout,
        currentMonitors = this._currentMonitorConfiguration.monitors) {
        if (!sourceLayout)
            throw new Error('Monitor correspondence has no selected source');

        const sourceMonitors = Object.entries(sourceLayout.monitors);
        const matchScores = sourceMonitors.map(([, sourceMonitor]) =>
            currentMonitors.map(currentMonitor =>
                this._getMonitorMatchScore(sourceMonitor, currentMonitor)));
        const destinationMonitorIndices = new Map();

        // Accept only a unique best match in both directions. Leave unresolved
        // references for each consumer's fallback policy; never guess identity.
        sourceMonitors.forEach(([reference], sourceIndex) => {
            const scores = matchScores[sourceIndex];
            const bestScore = Math.max(0, ...scores);
            const destinationIndex = scores.indexOf(bestScore);
            const reverseScores = matchScores.map(row =>
                row[destinationIndex]);

            const uniqueMatch = bestScore > 0 &&
                scores.lastIndexOf(bestScore) === destinationIndex &&
                Math.max(...reverseScores) === bestScore &&
                reverseScores.filter(score => score === bestScore)
                    .length === 1;

            destinationMonitorIndices.set(reference, uniqueMatch
                ? currentMonitors[destinationIndex].monitorIndex
                : undefined);
        });

        // Exact profile identity also works without hardware specifications.
        for (const [reference, sourceMonitor] of sourceMonitors) {
            if (destinationMonitorIndices.get(reference) !== undefined)
                continue;

            const key = this._createProfileKey('', [sourceMonitor]);
            const matches = currentMonitors.filter(monitor =>
                this._createProfileKey('', [monitor]) === key);
            const sourceMatches = sourceMonitors.filter(([, monitor]) =>
                this._createProfileKey('', [monitor]) === key);

            if (matches.length === 1 && sourceMatches.length === 1 &&
                ![...destinationMonitorIndices.values()].includes(
                    matches[0].monitorIndex
                )) {
                destinationMonitorIndices.set(reference,
                    matches[0].monitorIndex);
            }
        }

        if (destinationMonitorIndices.size === 0)
            throw new Error('Saved source has no monitor correspondence');

        return destinationMonitorIndices;
    }

    // Seed positions and normalized coordinates without changing source memory.
    _normalizeSourceIconCoordinates(fileList, sourceLayout,
        destinationMonitorIndices, preferredDesktop) {
        for (const fileItem of fileList) {
            const sourcePosition = sourceLayout.placements.icons[fileItem.uri];
            const monitorIndex = sourcePosition &&
                (destinationMonitorIndices.get(sourcePosition.monitor) ??
                    preferredDesktop?.monitorIndex);

            // No source means no adaptation. Sequential placement assigns
            // these items; pending drop destinations remain untouched.
            if (!sourcePosition || monitorIndex == null) {
                fileItem.savedCoordinates = null;
                continue;
            }

            const sourceMonitor = sourceLayout.monitors[sourcePosition.monitor];

            // The existing setter accepts X/Y, normalized X/Y and monitor index.
            // Source X/Y are temporary; conversion below maps them to the
            // destination's usable area and current global origin.
            fileItem.savedCoordinates = [
                sourcePosition.x, sourcePosition.y,
                sourcePosition.x / sourceMonitor.usableWidth,
                sourcePosition.y / sourceMonitor.usableHeight,
                monitorIndex,
            ];
        }
    }

    // Compare whole logical groups, including every mirrored physical member.
    // Require unique member matches rather than guessing between displays.
    _getMonitorMatchScore(sourceMonitor, currentMonitor) {
        if (!sourceMonitor.members.length ||
            sourceMonitor.members.length !== currentMonitor.members.length)
            return 0;

        const matchedMembers = new Set();
        let totalScore = 0;

        for (const sourceMember of sourceMonitor.members) {
            const scores = currentMonitor.members.map(currentMember =>
                this._getPhysicalMonitorMatchScore(sourceMember, currentMember)
            );
            const bestScore = Math.max(...scores);
            const memberIndex = scores.indexOf(bestScore);

            if (!bestScore || scores.lastIndexOf(bestScore) !== memberIndex ||
                matchedMembers.has(memberIndex))
                return 0;

            matchedMembers.add(memberIndex);
            totalScore += bestScore;
        }

        return totalScore;
    }

    // Serial is strongest; connector corroborates it or provides fallback.
    // Missing fields are unknown. Conflicting populated hardware fields veto.
    _getPhysicalMonitorMatchScore(source, current) {
        for (const field of ['vendor', 'product']) {
            if (source[field] && current[field] &&
                source[field] !== current[field])
                return 0;
        }

        const usableSerial = serial => {
            const value = (serial ?? '').trim();

            if (/^(?:0x)?0+$|^(?:unknown|none|n\/a)$/i.test(value))
                return '';

            return value;
        };
        const sourceSerial = usableSerial(source.serial);
        const currentSerial = usableSerial(current.serial);
        const sameConnector = Boolean(source.connector) &&
            source.connector === current.connector;

        if (sourceSerial && currentSerial) {
            if (sourceSerial !== currentSerial)
                return 0;

            return sameConnector ? 3 : 2;
        }

        return sameConnector ? 1 : 0;
    }

    _recomputeWindowPositions(fileList, desktops, preferredDesktop) {
        if (!desktops.length)
            return;

        fileList.forEach(fileItem => {
            if (fileItem.savedCoordinates == null)
                return;
            if (fileItem._normalCoordinates == null) {
                fileItem.savedCoordinates = null;
                return;
            }
            if (fileItem._monitorIndex == null)
                return;

            // Existing icons belong to their established monitor. Secondary
            // preference and primary designation do not relocate them.
            let desktop = desktops.find(surface =>
                surface.monitorIndex === fileItem._monitorIndex);

            // reassingn to new monitor, prior monitor not available
            if (!desktop)
                desktop = preferredDesktop;

            // if any error, leave unmapped to new monitor, placement algorithm
            //  will find placement from the old global position
            if (!desktop)
                return;

            fileItem.temporaryMonitorIndex = desktop.monitorIndex;

            // recompute coordinates for the new monitor
            const x = fileItem._normalCoordinates[0];
            const y = fileItem._normalCoordinates[1];
            const [newlocalX, newlocalY] =
                desktop.setNormalizedCoordinates(x, y);
            const [newGlobalX, newGlobalY] =
                desktop.coordinatesLocalToGlobal(newlocalX, newlocalY);
            fileItem.temporarySavedPosition = [newGlobalX, newGlobalY];
        });
    }

    _remapIconsToGridCells(fileList, desktops) {
        fileList.forEach(fileItem => {
            if (fileItem.savedCoordinates === null)
                return;

            if (fileItem._monitorIndex == null)
                return;

            const column = fileItem.column;
            const row = fileItem.row;

            if (column == null || row == null)
                return;

            const index = fileItem._monitorIndex;
            const [desktop] = desktops.filter(d => {
                return d.monitorIndex === index;
            });

            if (!desktop)
                return;

            const [newGlobalX, newGlobalY] =
                this._getGlobalPositionForGridCell(desktop, column, row);

            fileItem.temporarySavedPosition = [newGlobalX + 2, newGlobalY + 2];
        });
    }

    _getGlobalPositionForGridCell(desktop, column, row) {
        const {columnCount, rowCount} = this.getGridGeometry(desktop.index);

        // Preserve the strict bounds check and window-origin fallback.
        // Equality and negative indices retain the original cell arithmetic.
        if (column > columnCount || row > rowCount) {
            const {x, y} = desktop.windowGlobalRectangle;
            return [x, y];
        }

        const [localX, localY] = this.getCellLocalPosition(
            desktop.index, column, row
        );
        return desktop.coordinatesLocalToGlobal(localX, localY);
    }

    // WebCoLa input preparation
    // Build one destination-surface problem after affine mapping.
    // All node positions are centres in destination usable-area-local pixels.
    // The builders do not alter file items, profiles or the current display.

    // {
    //     nodes: [{id, x, y, width, height}, ...boundaryGuides],
    //     links: [{source: nodeIndex, target: nodeIndex, length, weight}],
    //     constraints: [{axis, left, right, gap, equality}],
    //     iconCount, // Leading icon nodes; trailing guides are not icons.
    //     settings: {width, height, maximumIterations},
    // }
    // Boundary guides have fixed: 1 and zero size. Validate their positions
    // after solving; WebCoLa can move them when constraints are infeasible.
    _createWebColaInput(fileList, sourceLayout, desktop, preferences) {
        const nodes = this._createWebColaIconNodes(
            fileList, sourceLayout, desktop, preferences.freePositionIcons
        );
        const iconCount = nodes.length;
        const width = desktop.normalizedWidth;
        const height = desktop.normalizedHeight;

        const links = this._createWebColaNeighbourLinks(
            nodes, sourceLayout
        );
        const constraints = this._createWebColaSurfaceConstraints(
            nodes, sourceLayout
        );

        this._addWebColaBoundaryGuides(nodes, width, height);

        return {
            nodes, links, constraints, iconCount,
            settings: {width, height, maximumIterations: 80},
        };
    }

    _createWebColaIconNodes(fileList, sourceLayout, desktop,
        freePositionIcons) {
        const {cellWidth, cellHeight} = this.getGridGeometry(desktop.index);
        const spacing = freePositionIcons ? desktop.elementSpacing : 0;
        const width = cellWidth - 2 * spacing;
        const height = cellHeight - 2 * spacing;
        const nodes = [];

        for (const fileItem of fileList) {
            const sourcePosition = sourceLayout.placements.icons[fileItem.uri];

            if (!sourcePosition ||
                fileItem._monitorIndex !== desktop.monitorIndex ||
                fileItem.savedCoordinates === null)
                continue;

            const [x, y] = desktop.coordinatesGlobalToLocal(
                ...fileItem.savedCoordinates
            );

            nodes.push({
                id: fileItem.uri, x: x + width / 2,
                y: y + height / 2, width, height,
            });
        }

        return nodes;
    }

    // Guides follow the icon nodes and represent opposite surface corners.
    _addWebColaBoundaryGuides(nodes, width, height) {
        nodes.push({x: 0, y: 0, width: 0, height: 0, fixed: 1});
        nodes.push({x: width, y: height, width: 0, height: 0, fixed: 1});
    }

    // Select up to five neighbours within two footprint units for each icon.
    // Union the selections: a pair appears once, but degree can exceed five.
    _createWebColaNeighbourLinks(nodes, sourceLayout) {
        const links = [];
        const linkedPairs = new Set();

        nodes.forEach((node, index) => {
            const source = sourceLayout.placements.icons[node.id];
            const neighbours = [];

            nodes.forEach((other, otherIndex) => {
                if (index === otherIndex)
                    return;

                const destination = sourceLayout.placements.icons[other.id];

                // Separate source surfaces do not share a local coordinate
                // system. Their icons still share destination overlap rules.
                if (source.monitor !== destination.monitor)
                    return;

                const dx = destination.x + other.width / 2 -
                    source.x - node.width / 2;
                const dy = destination.y + other.height / 2 -
                    source.y - node.height / 2;
                const distance = Math.hypot(dx / node.width, dy / node.height);

                if (distance <= 2) {
                    // Coincident source positions are valid, but WebCoLa
                    // divides by link length. Allow room for both footprints.
                    neighbours.push({
                        index: otherIndex, distance,
                        length: Math.max(Math.hypot(dx, dy),
                            Math.min(node.width + other.width,
                                node.height + other.height) / 2),
                    });
                }
            });

            neighbours.sort((a, b) =>
                a.distance - b.distance || a.index - b.index);

            for (const neighbour of neighbours.slice(0, 5)) {
                const sourceIndex = Math.min(index, neighbour.index);
                const targetIndex = Math.max(index, neighbour.index);
                const pairKey = `${sourceIndex}:${targetIndex}`;

                if (linkedPairs.has(pairKey))
                    continue;

                linkedPairs.add(pairKey);
                links.push({
                    source: sourceIndex, target: targetIndex,
                    length: neighbour.length, weight: 1,
                });
            }
        });

        return links;
    }

    // Bounds and firm source edge gaps, as verified in the isolated prototype.
    // Sequential placement settles any remaining bounds or overlap conflicts.
    _createWebColaSurfaceConstraints(nodes, sourceLayout) {
        const minimumGuide = nodes.length;
        const maximumGuide = nodes.length + 1;
        const constraints = [];

        nodes.forEach((node, index) => {
            const sourcePosition = sourceLayout.placements.icons[node.id];
            const sourceMonitor = sourceLayout.monitors[sourcePosition.monitor];

            for (const [axis, size, sourceSize] of [
                ['x', 'width', sourceMonitor.usableWidth],
                ['y', 'height', sourceMonitor.usableHeight],
            ]) {
                const halfSize = node[size] / 2;
                const nearGap = sourcePosition[axis];
                const farGap = sourceSize - sourcePosition[axis] - node[size];
                const nearAttached = nearGap >= 0 && nearGap <= halfSize;
                const farAttached = farGap >= 0 && farGap <= halfSize;

                constraints.push({
                    axis, left: minimumGuide, right: index,
                    gap: halfSize + (nearAttached ? nearGap : 0),
                    equality: nearAttached,
                });
                constraints.push({
                    axis, left: index, right: maximumGuide,
                    gap: halfSize + (farAttached ? farGap : 0),
                    equality: farAttached,
                });
            }
        });

        return constraints;
    }

    // WebCoLa execution and accepted positions
    // Keep affine file coordinates until a complete surface result is valid.

    _refineAffineLayout(fileList, sourceLayout, desktops, preferences) {
        for (const desktop of desktops) {
            if (!this._gridGeometries.has(desktop.index))
                continue;

            try {
                const input = this._createWebColaInput(
                    fileList, sourceLayout, desktop, preferences
                );
                const positions = this._runWebColaLayout(input);

                if (!positions)
                    continue;

                for (const position of positions) {
                    const fileItem = fileList.find(item =>
                        item.uri === position.id);
                    fileItem.temporarySavedPosition =
                        desktop.coordinatesLocalToGlobal(
                            position.x, position.y
                        );
                }
            } catch (error) {
                console.error(error,
                    'WebCoLa failed; keeping affine positions');
            }
        }
    }

    _runWebColaLayout(input) {
        const {nodes, links, constraints, iconCount, settings} = input;

        if (!iconCount || nodes.slice(0, iconCount).some(node =>
            !Number.isFinite(node.x) || !Number.isFinite(node.y) ||
            !Number.isFinite(node.width) || !Number.isFinite(node.height) ||
            node.width <= 0 || node.height <= 0 ||
            node.width > settings.width || node.height > settings.height))
            return null;

        new WebCola.Layout().nodes(nodes).links(links)
            .linkDistance(link => link.length)
            .constraints(constraints).avoidOverlaps(true)
            .handleDisconnected(false).size([settings.width, settings.height])
            .start(0, 0, settings.maximumIterations, 0, false, false);

        if (!this._isWebColaResultValid(input))
            return null;

        return nodes.slice(0, iconCount).map(node => ({
            id: node.id,
            x: node.x - node.width / 2,
            y: node.y - node.height / 2,
        }));
    }

    _isWebColaResultValid({nodes, iconCount}) {
        // Sequential placement handles final bounds, snapping and overlaps.
        return nodes.length === iconCount + 2 && nodes.every(node =>
            Number.isFinite(node.x) && Number.isFinite(node.y));
    }

    // Grid assignment after WebCoLa
    // Minimize total squared movement to distinct cells on one surface.
    // This proposes coordinates only; sequential placement applies them.

    _snapFilePositionsToGrid(fileList, desktops) {
        for (const desktop of desktops) {
            const positions = fileList.filter(fileItem =>
                fileItem._monitorIndex === desktop.monitorIndex &&
                fileItem.savedCoordinates !== null
            ).map(fileItem => {
                const [x, y] = desktop.coordinatesGlobalToLocal(
                    ...fileItem.savedCoordinates
                );
                return {id: fileItem.uri, x, y};
            });
            const assignedPositions = this._assignPositionsToGrid(
                positions, desktop
            );

            for (const position of assignedPositions) {
                const fileItem = fileList.find(item => item.uri === position.id);
                fileItem.temporarySavedPosition =
                    desktop.coordinatesLocalToGlobal(position.x, position.y);
            }
        }
    }

    _assignPositionsToGrid(positions, desktop) {
        const {columnCount, rowCount} = this.getGridGeometry(desktop.index);

        // An overcrowded surface still uses the existing sequential fallback.
        if (!positions.length || positions.length > columnCount * rowCount)
            return positions;

        const cells = [];

        for (let column = 0; column < columnCount; column++) {
            for (let row = 0; row < rowCount; row++) {
                const [x, y] = this.getCellLocalPosition(
                    desktop.index, column, row
                );
                cells.push({
                    x: x + desktop.elementSpacing,
                    y: y + desktop.elementSpacing,
                });
            }
        }

        const costs = positions.map(position => cells.map(cell =>
            (position.x - cell.x) ** 2 + (position.y - cell.y) ** 2));
        const assignedCells = this._findMinimumCostAssignment(costs);

        return positions.map((position, index) => ({
            id: position.id, ...cells[assignedCells[index]],
        }));
    }

    // Rectangular Hungarian algorithm: one distinct column per row.
    // Potentials expose the cheapest augmenting path without enumerating
    // assignments. O(iconCount² * cellCount); ties follow cell order.
    _findMinimumCostAssignment(costs) {
        const rowCount = costs.length;
        const columnCount = costs[0].length;
        const rowPotentials = Array(rowCount + 1).fill(0);
        const columnPotentials = Array(columnCount + 1).fill(0);
        const matchedRows = Array(columnCount + 1).fill(0);
        const previousColumns = Array(columnCount + 1).fill(0);

        // Index zero is the temporary root of each augmenting path.
        for (let row = 1; row <= rowCount; row++) {
            matchedRows[0] = row;
            let currentColumn = 0;
            const minimumCosts = Array(columnCount + 1).fill(Infinity);
            const visitedColumns = Array(columnCount + 1).fill(false);

            do {
                visitedColumns[currentColumn] = true;
                const currentRow = matchedRows[currentColumn];
                let adjustment = Infinity;
                let nextColumn = 0;

                for (let column = 1; column <= columnCount; column++) {
                    if (visitedColumns[column])
                        continue;

                    const reducedCost = costs[currentRow - 1][column - 1] -
                        rowPotentials[currentRow] - columnPotentials[column];

                    if (reducedCost < minimumCosts[column]) {
                        minimumCosts[column] = reducedCost;
                        previousColumns[column] = currentColumn;
                    }

                    if (minimumCosts[column] < adjustment) {
                        adjustment = minimumCosts[column];
                        nextColumn = column;
                    }
                }

                for (let column = 0; column <= columnCount; column++) {
                    if (visitedColumns[column]) {
                        rowPotentials[matchedRows[column]] += adjustment;
                        columnPotentials[column] -= adjustment;
                    } else {
                        minimumCosts[column] -= adjustment;
                    }
                }

                currentColumn = nextColumn;
            } while (matchedRows[currentColumn] !== 0);

            // Reverse the path, moving earlier assignments as needed.
            do {
                const previousColumn = previousColumns[currentColumn];
                matchedRows[currentColumn] = matchedRows[previousColumn];
                currentColumn = previousColumn;
            } while (currentColumn !== 0);
        }

        const assignedColumns = Array(rowCount);

        for (let column = 1; column <= columnCount; column++) {
            if (matchedRows[column])
                assignedColumns[matchedRows[column] - 1] = column - 1;
        }

        return assignedColumns;
    }

    // Current placement algorithm — sequential placement
    // Place known, dropped and new icons in sequence. Keep monitor selection,
    // cell search, snapping and freeform decisions together.
    // Apply and reserve each result before calculating the next item.
    // This sequential order is not required of future algorithms.

    // Cleanup preserves current spatial order before sequential reassignment.
    cleanUpFilesOnDesktop(fileList, placementContext) {
        this._sortFilesByCurrentPosition(
            fileList, placementContext.preferences.startCorner
        );
        return this.reassignFilesOnDesktop(fileList, placementContext);
    }

    // Reassignment clears positions according to the special-icon policy,
    // then uses the same sequential placement as ordinary placement requests.
    reassignFilesOnDesktop(fileList, placementContext) {
        const preparedFiles = this._prepareFilesForReassignment(
            fileList, placementContext.preferences.sortSpecialFolders
        );
        this.placeFilesOnDesktop(preparedFiles, placementContext);

        return preparedFiles;
    }

    // Calls without a layout request keep ordinary sequential placement.
    placeFilesOnDesktop(fileList, placementContext) {
        const {desktops, primaryMonitorIndex, preferences} = placementContext;
        const preferredDesktop = this.getPreferredDesktop(
            desktops, primaryMonitorIndex, preferences.showOnSecondaryMonitor
        );

        this._adaptIconPositions(fileList, placementContext, preferredDesktop);

        if (!preferredDesktop)
            return;

        let outOfDesktops = [];
        let notAssignedYet = [];
        let droppedFiles = [];

        // First, add those icons that have saved coordinates
        // and fit in the current desktops
        for (let fileItem of fileList) {
            if (fileItem.savedCoordinates === null) {
                if (fileItem.dropCoordinates !== null)
                    droppedFiles.push(fileItem);
                else
                    notAssignedYet.push(fileItem);
                continue;
            }

            let [itemX, itemY] = fileItem.savedCoordinates;
            let addedToDesktop = false;

            for (let desktop of desktops) {
                if (desktop
                    .coordinatesBelongToThisGridWindow(itemX, itemY) &&
                    this._hasAvailableCell(desktop.index)) {
                    addedToDesktop = this._placeIconOnDesktop(
                        fileItem, desktop, itemX, itemY, preferences
                    );

                    if (addedToDesktop)
                        break;
                }
            }

            if (!addedToDesktop)
                outOfDesktops.push(fileItem);
        }

        // Now, assign icons that have landed in changed margins, belong to
        // monitor and the window, however no longer fit on the grid as
        // they overlap margins.

        if (outOfDesktops.length) {
            this._placeFilesOnFallbackDesktop(
                outOfDesktops,
                preferredDesktop,
                placementContext
            );
        }

        outOfDesktops = [];

        // Now assign those icons that have dropped coordinates
        for (let fileItem of droppedFiles) {
            let [x, y] = fileItem.dropCoordinates;
            let addedToDesktop = false;

            for (let desktop of desktops) {
                if (desktop.coordinatesBelongToThisGrid(x, y) &&
                    this._hasAvailableCell(desktop.index)) {
                    addedToDesktop = this._placeIconOnDesktop(
                        fileItem, desktop, x, y, preferences
                    );

                    if (addedToDesktop)
                        break;
                }
            }

            if (!addedToDesktop)
                outOfDesktops.push(fileItem);
        }

        // Now, try again assign those icons that had dropped coordinates and
        // did not fit on dropped desktop, to the preferred or closest desktop
        if (outOfDesktops.length) {
            this._placeFilesOnFallbackDesktop(
                outOfDesktops,
                preferredDesktop,
                placementContext
            );
            outOfDesktops = [];
        }

        // Finally, assign coordinates of preferred desktop to those new icons
        // that still don't have coordinates and place on preferred desktop or
        // the next closest one
        for (let fileItem of notAssignedYet) {
            let x = preferredDesktop.gridGlobalRectangle.x;
            let y = preferredDesktop.gridGlobalRectangle.y;

            // try first in the designated desktop
            let assigned = false;
            if (preferredDesktop.coordinatesBelongToThisGrid(x, y) &&
                this._hasAvailableCell(preferredDesktop.index)) {
                assigned = this._placeIconOnDesktop(
                    fileItem, preferredDesktop, x, y, preferences
                );
            }

            if (!assigned)
                outOfDesktops.push(fileItem);
        }

        // if there was no space in the preferred desktop, place on the
        // desktop closest to preferred
        if (outOfDesktops.length) {
            this._placeFilesOnFallbackDesktop(
                outOfDesktops,
                preferredDesktop,
                placementContext
            );
        }
    }

    getPreferredDesktop(desktops, primaryMonitorIndex,
        showOnSecondaryMonitor) {
        if (!desktops.length)
            return null;

        if (desktops.length === 1)
            return desktops[0];

        if (!showOnSecondaryMonitor && primaryMonitorIndex !== null) {
            return desktops.filter(desktop =>
                desktop.monitorIndex === primaryMonitorIndex)[0];
        }

        // Preserve the existing array-index-based secondary policy. Array
        // position and monitorIndex are deliberately not interchanged here.
        const secondaryDesktops = desktops.filter((_desktop, arrayIndex) =>
            arrayIndex !== primaryMonitorIndex);

        if (desktops.length > 1) {
            if (secondaryDesktops.length === 1)
                return secondaryDesktops[0];

            if (secondaryDesktops.length <= primaryMonitorIndex)
                return secondaryDesktops[0];

            return secondaryDesktops[secondaryDesktops.length - 1];
        }

        return desktops[0];
    }

    _getClosestDesktop(desktops, itemPositionX) {
        let closestDesktop = null;
        let closestDistance = 100000000000;

        // Preserve the original distance cap, strict tie-breaking and surface
        // distance function; do not replace it with a new spatial heuristic.
        for (const desktop of desktops) {
            if (!this._hasAvailableCell(desktop.index))
                continue;

            const distance = this._getDesktopDistance(desktop, itemPositionX);

            if (distance < closestDistance) {
                closestDesktop = desktop;
                closestDistance = distance;
            }
        }

        return closestDesktop;
    }

    _getDesktopDistance(desktop, itemPositionX) {
        const {x, y, width, height} = desktop.windowGlobalRectangle;
        const geometryScale = desktop.geometryScale;

        // Preserve the original metric, including X in both terms and the
        // multiplication after window dimensions have already been floored.
        return Math.pow(itemPositionX - (x + width * geometryScale / 2), 2) +
            Math.pow(itemPositionX - (y + height * geometryScale / 2), 2);
    }

    _prepareFilesForReassignment(fileList, sortSpecialFolders) {
        const specialFiles = [];
        const otherFiles = [];

        for (const fileItem of fileList) {
            if (!sortSpecialFolders && fileItem._isSpecial) {
                specialFiles.push(fileItem);
                continue;
            }

            fileItem.temporarySavedPosition = null;
            fileItem.dropCoordinates = null;
            otherFiles.push(fileItem);
        }

        // Preserve the live list when all files are reassigned. Otherwise,
        // special files keep their coordinates and precede ordinary files.
        return sortSpecialFolders
            ? fileList : [...specialFiles, ...otherFiles];
    }

    _placeIconOnDesktop(fileItem, desktop, globalX, globalY, preferences) {
        if (!this._gridGeometries.has(desktop.index))
            return false;

        const placement = this._calculateIconPlacement(
            fileItem, desktop, globalX, globalY, preferences
        );
        const applied = desktop.applyIconPlacement(fileItem, placement);

        if (!applied)
            return false;

        this._reserveIconPlacement(fileItem, desktop, placement);
        fileItem.dropCoordinates = null;
        return true;
    }

    _calculateIconPlacement(fileItem, desktop, globalX, globalY, preferences) {
        const [localX, localY] = desktop.coordinatesGlobalToLocal(
            globalX, globalY
        );
        const [column, row] = this._findAvailableCell(
            desktop.index, fileItem, localX, localY, {
                startCorner: preferences.startCorner,
                reverseHorizontal: fileItem.isDrive &&
                    preferences.addVolumesOpposite,
            }
        );
        const placement = this._calculateItemPlacement(desktop.index, {
            localX, localY, column, row,
            // Newly recorded drops are still placement requests. Preserve
            // the existing drop-placement rules, including freeform mode.
            savedCoordinates: fileItem.pendingPlacementReason === 'user-drop'
                ? null : fileItem.savedCoordinates,
            freePositionIcons: preferences.freePositionIcons,
            keepArranged: preferences.keepArranged,
            keepStacked: preferences.keepStacked,
            spacing: desktop.elementSpacing,
        });

        if (placement.snappedToGrid || placement.positionAdjusted) {
            [globalX, globalY] = desktop.coordinatesLocalToGlobal(
                placement.localX, placement.localY
            );
        }

        // The renderer receives the frame and optional cell annotation.
        // Cell reservation stays here, outside the rendering operation.
        return {
            ...placement, globalX, globalY,
            cell: placement.snappedToGrid
                ? {column: placement.column, row: placement.row} : null,
        };
    }

    _findAvailableCell(gridIndex, fileItem, localX, localY, {
        startCorner, reverseHorizontal,
    }) {
        // The current algorithm scans from the configured corner only for
        // unpositioned items. Remembered positions and drops seek nearby cells.
        const searchFromCorner = fileItem.savedCoordinates === null &&
            fileItem.dropCoordinates === null;

        const {columnCount, rowCount, cellWidth, cellHeight} =
            this.getGridGeometry(gridIndex);

        const reverseColumns = reverseHorizontal
            ? !startCorner[0] : startCorner[0];

        const reverseRows = startCorner[1];
        const [requestedColumn, requestedRow] =
            this.getCellAtPosition(gridIndex, localX, localY);

        if (this.isCellEmpty(gridIndex, requestedColumn, requestedRow) &&
            !searchFromCorner)
            return [requestedColumn, requestedRow];

        let closestColumn = null;
        let closestRow = null;
        let minimumDistance = Infinity;
        let foundAvailableCell = false;

        // Preserve column-first traversal. Corner search takes the first empty
        // cell; otherwise minimize distance to rounded cell origins.
        // Strict improvement preserves corner-based ties. O(columns * rows)
        // time and O(1) space; occupancy is queried, not changed here.
        for (let columnOffset = 0; columnOffset < columnCount;
            columnOffset++) {
            const column = reverseColumns
                ? columnCount - columnOffset - 1 : columnOffset;

            for (let rowOffset = 0; rowOffset < rowCount; rowOffset++) {
                const row = reverseRows
                    ? rowCount - rowOffset - 1 : rowOffset;

                if (!this.isCellEmpty(gridIndex, column, row))
                    continue;

                const proposedX = column * cellWidth;
                const proposedY = row * cellHeight;

                if (searchFromCorner)
                    return [column, row];

                const distance = Math.pow(proposedX - localX, 2) +
                    Math.pow(proposedY - localY, 2);

                if (distance < minimumDistance) {
                    foundAvailableCell = true;
                    minimumDistance = distance;
                    closestColumn = column;
                    closestRow = row;
                }
            }
        }

        if (!foundAvailableCell)
            throw new Error('No available space on the monitor');

        return [closestColumn, closestRow];
    }

    _calculateItemPlacement(gridIndex, {
        localX, localY, column, row, savedCoordinates,
        freePositionIcons, keepArranged, keepStacked, spacing,
    }) {
        const {width, height, cellWidth, cellHeight, columnCount, rowCount} =
            this.getGridGeometry(gridIndex);

        const snappedToGrid = savedCoordinates == null ||
            (savedCoordinates[0] === 0 && savedCoordinates[1] === 0) ||
            !freePositionIcons || keepArranged || keepStacked;

        let positionAdjusted = false;

        if (snappedToGrid) {
            [localX, localY] =
                this.getCellLocalPosition(gridIndex, column, row);
            localX += spacing;
            localY += spacing;
        } else {
            // Preserve the original pre-clamp cell for occupancy bookkeeping.
            // Clamp axes in the original order; do not add collision handling.
            [column, row] = this.getCellAtPosition(gridIndex, localX, localY);

            if (column === columnCount - 1 && localX + cellWidth > width) {
                localX = width - cellWidth;
                positionAdjusted = true;
            }

            if (row === rowCount - 1 && localY + cellHeight > height) {
                localY = height - cellHeight;
                positionAdjusted = true;
            }

            if (localX < 0) {
                localX = 0;
                positionAdjusted = true;
            }

            if (localY < 0) {
                localY = 0;
                positionAdjusted = true;
            }
        }

        // O(1) arithmetic; cell extents include the same spacing as before.
        return {
            localX,
            localY,
            width: cellWidth - 2 * spacing,
            height: cellHeight - 2 * spacing,
            spacing,
            column,
            row,
            snappedToGrid,
            positionAdjusted,
        };
    }

    _placeFilesOnFallbackDesktop(fileList, preferredDesktop,
        {desktops, preferences}) {
        for (let fileItem of fileList) {
            let desktopX;
            let x = desktopX = preferredDesktop.gridGlobalRectangle.x;
            let desktopY = preferredDesktop.gridGlobalRectangle.y;

            if (fileItem.savedCoordinates)
                x = fileItem.savedCoordinates[0];
            else if (fileItem.dropCoordinates)
                x = fileItem.dropCoordinates[0];


            // Rejected surfaces must not prevent trying another candidate.
            // Keep the existing distance policy and order on successful paths.
            let candidates = desktops;
            let placed = false;

            while (candidates.length) {
                const newDesktop = this._getClosestDesktop(candidates, x);

                if (!newDesktop)
                    break;

                desktopX = newDesktop.gridGlobalRectangle.x;
                desktopY = newDesktop.gridGlobalRectangle.y;
                placed = this._placeIconOnDesktop(
                    fileItem, newDesktop, desktopX, desktopY, preferences
                );

                if (placed)
                    break;

                candidates = candidates.filter(surface =>
                    surface !== newDesktop);
            }

            if (!placed) {
                console.log('Not enough space to add icons');
                fileItem.iconCannotBeShown();
            }
        }
    }

    // Getters and setters
    // Expose remembered profile data separately from live monitor enumeration.

    // Null before profile selection. Frozen references selected at transition:
    // {
    //     source: null | {profileKey, layout},
    //     destination: {profileKey, layout: null | rememberedLayout},
    //     requiresTransformation: boolean,
    // }
    // An unseen destination with no source uses ordinary initial placement.
    // Same-key geometry updates retain the selection. Later reconciliation
    // does not replace these snapshots; rememberedLayout exposes live memory.
    // Startup sources use the last settled profile saved for this namespace.
    get profileTransition() {
        return this._profileTransition;
    }

    // Consumers read the selected correspondence; they must not modify it.
    get sourceMonitorIndices() {
        if (this._destinationMonitorIndices === null) {
            this._destinationMonitorIndices =
                this._resolveSourceMonitorIndices(this._sourceLayout);
        }

        return this._destinationMonitorIndices;
    }

    get rememberedLayout() {
        return this._rememberedLayouts.get(
            this._currentMonitorConfiguration?.key
        ) ?? null;
    }
}
