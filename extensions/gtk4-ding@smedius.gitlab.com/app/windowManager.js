/* DING: Desktop Icons New Generation for GNOME Shell
 *
 * Adw/Gtk4 Port Copyright (C) 2025 Sundeep Mediratta (smedius@gmail.com)
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
import {
    DesktopGrid
} from '../dependencies/localFiles.js';

import {Gio, GLib, DesktopWidgetCapability} from '../dependencies/gi.js';

export {WindowManager};

const WindowManager = class {
    constructor(desktopManager, desktopList, asDesktop, primaryIndex) {
        this._desktopManager = desktopManager;
        this._Prefs = desktopManager.Prefs;
        this.mainApp = desktopManager.mainApp;
        this._desktopList = desktopList;
        this._primaryIndex = primaryIndex;

        if (primaryIndex < desktopList.length)
            this._primaryScreen = desktopList[primaryIndex];
        else
            this._primaryScreen = null;

        this._priorDesktopList = [];
        this._desktops = [];
        this._asDesktop = asDesktop;
        this._zoom = 1;
        this._primaryMonitorIndex = null;
        this._priorPrimaryIndex = null;
        this._priorPrimaryMonitorIndex = null;
        this._differentZooms = false;
        this._scaleFactorChanged = false;
        this._priorScaleFactor = null;
        this._hidden = false;
        this._pendingGridWindowsUpdate = null;
        this._gridWindowsUpdatePromise = null;
        this._lastAppliedGeometry = null;
        this._lastReceivedDesktopUpdate = null;
        this._monitorMembers = {};
        this._geometryTransition = null;
        this._geometryNeedsRecovery = false;

        this._registerWidgetLayerAction();
        this._dbusAdvertiseUpdate();
    }

    _dbusAdvertiseUpdate() {
        const updateGridWindows = new Gio.SimpleAction({
            name: 'updateGridWindows',
            parameter_type: new GLib.VariantType('av'),
        });

        updateGridWindows.connect('activate', (action, parameter) => {
            this.updateGridWindows(parameter)
            .catch(e => logError(e));
        });

        this.mainApp.add_action(updateGridWindows);

        const busObjectPath = this.mainApp.get_dbus_object_path();
        const busName = this.mainApp.get_application_id();
        const connection = Gio.DBus.session;
        const signalName = 'updategeometry';

        const signalXml = `
                <node>
                  <interface name="${busName}">
                    <signal name="${signalName}">
                      <arg name="type" type="s"/>
                      <arg name="value" type="b"/>
                    </signal>
                  </interface>
                </node>`;

        this._dbusGeometryIface =
                Gio.DBusExportedObject.wrapJSObject(signalXml, this);

        this._dbusGeometryIface.export(
            connection,
            busObjectPath
        );
    }

    requestGeometryUpdate() {
        const variant = new GLib.Variant('(sb)', ['updategeometry', true]);
        const busObjectPath = this.mainApp.get_dbus_object_path();
        const busName = this.mainApp.get_application_id();
        const connection = Gio.DBus.session;
        const signalName = 'updategeometry';

        connection.emit_signal(
            null,
            busObjectPath,
            busName,
            signalName,
            variant
        );
    }

    async updateGridWindows(updateData) {
        // Keep only the latest pending request while a grid update is already
        // running. That lets us serialize the actual work and skip bursty
        // intermediate geometry changes that would be replaced anyway.
        this._pendingGridWindowsUpdate = updateData;

        if (this._gridWindowsUpdatePromise != null) {
            await this._gridWindowsUpdatePromise;
            return;
        }

        const updatePromise = (async () => {
            let lastError = null;

            // Drain the newest pending request one at a time so bursty
            // geometry changes collapse down to the latest state.
            while (this._pendingGridWindowsUpdate != null) {
                const nextUpdate = this._pendingGridWindowsUpdate;
                this._pendingGridWindowsUpdate = null;

                try {
                    // eslint-disable-next-line no-await-in-loop
                    await this._desktopManager.runSerializedDesktopMutation(
                        async () => {
                            if (!this._geometryNeedsRecovery &&
                                this._lastReceivedDesktopUpdate?.equal(nextUpdate))
                                return;

                            const {geometry, monitorMembers} =
                                this._decodeDesktopUpdate(nextUpdate);
                            // Keep member data even when geometry is unchanged.
                            this._monitorMembers = monitorMembers;
                            const geometryChanged = this._geometryNeedsRecovery ||
                                !this._lastAppliedGeometry?.equal(geometry);
                            const desktopList = geometry.recursiveUnpack();

                            let profileChanged = false;

                            try {
                                profileChanged =
                                    this._desktopManager.layoutManager
                                    .updateMonitorConfiguration(
                                        desktopList, monitorMembers);

                                if (profileChanged) {
                                    this._desktopManager
                                        .discardPendingDropDestinations();
                                }
                            } catch (error) {
                                console.error(error,
                                    'Failed to update layout profile');
                            }

                            if (!geometryChanged) {
                                this._recordGeometryTransition(desktopList, {
                                    profileChanged,
                                });
                                if (profileChanged) {
                                    await this._desktopManager
                                        .applyDesktopLayoutChange({
                                            operationFlags: {redisplay: true},
                                            geometryTransition:
                                                this.geometryTransition,
                                        });
                                }

                                this._lastReceivedDesktopUpdate = nextUpdate;
                                return;
                            }
                            try {
                                await this._applyGridWindowsUpdate(
                                    desktopList, profileChanged
                                );
                            } catch (e) {
                                this._lastAppliedGeometry = null;
                                this._geometryNeedsRecovery = true;
                                throw e;
                            }
                            this._geometryNeedsRecovery = false;
                            this._lastAppliedGeometry = geometry;
                            this._lastReceivedDesktopUpdate = nextUpdate;
                        }
                    );
                    lastError = null;
                } catch (e) {
                    lastError = e;
                }
            }

            if (lastError != null)
                throw lastError;
        })();

        const flushPromise = updatePromise.finally(() => {
            this._gridWindowsUpdatePromise = null;
        });

        this._gridWindowsUpdatePromise = flushPromise;
        await flushPromise;

        if (this._pendingGridWindowsUpdate != null)
            await this.updateGridWindows(this._pendingGridWindowsUpdate);
    }

    _decodeDesktopUpdate(updateData) {
        // av [geometry: av of a{sd}, members: a{iaa{sv}}]. Extract the
        // existing geometry Variant directly; unpack only after it differs.
        const geometry = updateData.get_child_value(0).get_variant();
        const monitorMembers = updateData.get_child_value(1).get_variant().recursiveUnpack();
        return {geometry, monitorMembers};
    }

    get monitorMembers() {
        return this._monitorMembers;
    }

    // One payload crosses into DesktopManager and WidgetManager:
    // {
    //     operationFlags: {redisplay, monitorschanged, gridschanged},
    //     geometryTransition: {previous, current, changes},
    // }
    // Startup/read/redraw requests can additionally set initialRead and omit
    // geometryTransition. Geometry facts do not repeat execution flags.
    async _applyGridWindowsUpdate(desktopList, profileChanged = false) {
        const changes = this._computeDesktopChangeInfo(desktopList);

        // Rebuilding existing windows requires all placement work, even when
        // recovery found no new geometry difference.
        if (this._geometryNeedsRecovery ||
            (!changes.firstDesktop && changes.monitorCountChanged)) {
            changes.redisplay = true;
            changes.monitorschanged = true;
            changes.gridschanged = true;
        }

        changes.profileChanged = profileChanged;
        changes.windowsRebuilt = this._geometryNeedsRecovery ||
            changes.firstDesktop || changes.monitorCountChanged;
        this._recordGeometryTransition(desktopList, changes);

        // Build once. Clearing, icon placement and widget placement all
        // receive this same request and the geometry it belongs to.
        const layoutRequest = {
            operationFlags: {
                redisplay: changes.redisplay,
                monitorschanged: changes.monitorschanged,
                gridschanged: changes.gridschanged,
                marginsChanged: changes.marginsChanged ?? false,
            },
            geometryTransition: this.geometryTransition,
        };

        if (this._geometryNeedsRecovery) {
            await this._handleMonitorCountChange(layoutRequest);
            return;
        }

        if (changes.firstDesktop) {
            await this._handleFirstDesktop(layoutRequest);
            return;
        }

        if (changes.monitorCountChanged) {
            await this._handleMonitorCountChange(layoutRequest);
            return;
        }

        if (changes.redisplay)
            await this._handleRedisplay(layoutRequest);
    }

    async _handleMonitorCountChange(layoutRequest) {
        // monitor has been plugged in or removed.
        this._desktopManager.clearAllLayersFromGrids(layoutRequest);
        await this.createGridWindows();

        // WindowManager owns the serialized geometry update flow; desktopManager
        // only applies the resulting desktop mutations.
        await this._desktopManager.applyDesktopLayoutChange(layoutRequest);

        this.queue_draw();
    }

    async _handleFirstDesktop(layoutRequest) {
        this._desktopManager.clearAllLayersFromGrids(layoutRequest);
        await this.createGridWindows();

        // sanity checks and icons placement on grid will be done by
        // desktopManager in sync startup
    }

    async _handleRedisplay(layoutRequest) {
        const changes = layoutRequest.geometryTransition.changes;

        await this._displayDesktopSnapShots();
        this._desktopManager.clearAllLayersFromGrids(layoutRequest);

        this._desktops.forEach((desktop, index) => {
            const monitor = this._desktopList[index];
            desktop.updateGridDescription(monitor);

            if (changes.windowResizeMonitorIndices
                .includes(monitor.monitorIndex)) {
                desktop.resizeWindow();
                desktop.resizeGrid();
            } else if (changes.gridResizeMonitorIndices
                .includes(monitor.monitorIndex)) {
                desktop.resizeGrid();
            }
        });

        await this._desktopManager.applyDesktopLayoutChange(layoutRequest);

        // animate to the new margins and positions
        // force a queue draw of all windows now that we have drawn the desktop,
        // and poke mutter to map the meta window.
        this._displayAnimationToLive();
    }


    _updatePrimaryStateAndZoomInfo(newdesktoplist) {
        // Save prior primary state
        this._priorPrimaryIndex = this._primaryIndex ?? null;
        this._priorPrimaryMonitorIndex = this._primaryMonitorIndex ?? 0;

        // Compute new primary index
        let newPrimaryIndex;

        if (newdesktoplist.length > 0 &&
            ('primaryMonitor' in newdesktoplist[0]))
            newPrimaryIndex = newdesktoplist[0].primaryMonitor ?? null;

        // Update primary index if changed
        if (newPrimaryIndex !== this._priorPrimaryIndex)
            this._primaryIndex = newPrimaryIndex;

        // Find the new primary monitor
        this._primaryScreen = this._desktopList[this._primaryIndex] ?? null;
        this._primaryMonitorIndex = this._primaryScreen.monitorIndex ?? null;

        const previousScaleFactor = this._priorScaleFactor;
        const currentScaleFactor = this._desktopList[0]?.scaleFactor ?? null;
        this._scaleFactorChanged = currentScaleFactor !== previousScaleFactor;
        this._priorScaleFactor = currentScaleFactor;

        // See if there are different zooms in the desktops when logical scaling
        // is not active. If scaleFactor is 1, zoom differences do not matter.
        this._differentZooms = this._desktopList[0]?.scaleFactor !== 1 &&
            this._desktopList.some((d, index) => {
                const nextd = this._desktopList[index + 1];
                if (nextd != null)
                    return d.zoom !== nextd.zoom;
                return false;
            });
    }

    // Snapshot the completed comparison before placement starts. Nested data
    // is copied and frozen so a retained transition survives later updates.
    // Margins are reported values, including hidden-edge encoding; usable
    // bounds additionally depend on DesktopGrid padding and grid arithmetic.
    _recordGeometryTransition(desktopList, changes) {
        const monitorsByIndex = {};

        for (const geometry of desktopList) {
            const divisor = geometry.scaleFactor === 1 ? 1 : geometry.zoom;
            const physicalMembers =
                this._monitorMembers[geometry.monitorIndex] ?? [];

            monitorsByIndex[geometry.monitorIndex] = Object.freeze({
                monitorIndex: geometry.monitorIndex,
                globalOrigin: Object.freeze({x: geometry.x, y: geometry.y}),
                reportedSize: Object.freeze({
                    width: geometry.width, height: geometry.height,
                }),
                logicalSize: Object.freeze({
                    width: Math.floor(geometry.width / divisor),
                    height: Math.floor(geometry.height / divisor),
                }),
                reportedMargins: Object.freeze({
                    top: geometry.marginTop, bottom: geometry.marginBottom,
                    left: geometry.marginLeft, right: geometry.marginRight,
                }),
                scaling: Object.freeze({
                    zoom: geometry.zoom, scaleFactor: geometry.scaleFactor,
                }),
                physicalMembers: Object.freeze(physicalMembers.map(member =>
                    Object.freeze({...member}))),
            });
        }

        const previous = this._geometryTransition?.current ?? null;
        const primaryArrayIndex = desktopList[0]?.primaryMonitor ??
            this._primaryIndex;
        const primaryMonitorIndex =
            desktopList[primaryArrayIndex]?.monitorIndex ?? null;
        const monitorIndices = indices => Object.freeze(
            indices.map(index => desktopList[index].monitorIndex)
        );

        this._geometryTransition = Object.freeze({
            previous,
            current: Object.freeze({
                primaryMonitorIndex,
                monitorsByIndex: Object.freeze(monitorsByIndex),
            }),
            changes: Object.freeze({
                // Boolean: the profile key changed from the previous key.
                // False for initial selection; does not mean target is new.
                profileChanged: changes.profileChanged ?? false,
                windowResizeMonitorIndices:
                    monitorIndices(changes.monitorschangedList ?? []),
                gridResizeMonitorIndices:
                    monitorIndices(changes.gridschangedList ?? []),
                windowsRebuilt: changes.windowsRebuilt ?? false,
            }),
        });
    }

    _computeDesktopChangeInfo(newDesktopList) {
        const priorDesktopList = this._desktopList;
        this._priorDesktopList = priorDesktopList;

        this._desktopList = newDesktopList;

        this._updatePrimaryStateAndZoomInfo(newDesktopList);

        // Allow initial startup if no desktops defined on initiation
        const firstDesktop =
            priorDesktopList.some(d => typeof d !== 'object' || d == null) ||
            priorDesktopList.length === 0;

        const monitorCountChanged =
            priorDesktopList.length !== newDesktopList.length;

        const monitorschangedList = [];
        const gridschangedList = [];
        let marginsChanged = false;

        // If this is the first desktop, we don't need finer diffing;
        if (firstDesktop) {
            return {
                firstDesktop,
                monitorCountChanged,
                monitorschangedList,
                gridschangedList,
                marginsChanged,
                monitorschanged: false,
                gridschanged: false,
                redisplay: false,
            };
        }

        if (this._scaleFactorChanged) {
            newDesktopList.forEach((_area, index) => {
                monitorschangedList.push(index);
                gridschangedList.push(index);
            });

            return {
                firstDesktop,
                monitorCountChanged,
                monitorschangedList,
                gridschangedList,
                marginsChanged,
                monitorschanged: true,
                gridschanged: true,
                redisplay: true,
            };
        }

        // if no change in monitors, check if any change in monitor geometry
        // or if any change in grid geometry
        newDesktopList.forEach((area, index) => {
            const area2 = priorDesktopList[index];

            if (!area || !area2) {
                // Monitor count changed; mark this index as changed and skip diff
                monitorschangedList.push(index);
                gridschangedList.push(index);
                return;
            }

            if ((area.marginTop !== area2.marginTop) ||
                (area.marginBottom !== area2.marginBottom) ||
                (area.marginLeft !== area2.marginLeft) ||
                (area.marginRight !== area2.marginRight)
            ) {
                marginsChanged = true;

                if (!gridschangedList.includes(index))
                    gridschangedList.push(index);
            }

            if ((area.x !== area2.x) ||
                (area.y !== area2.y) ||
                (area.width !== area2.width) ||
                (area.height !== area2.height) ||
                (area.zoom !== area2.zoom) ||
                (area.monitorIndex !== area2.monitorIndex)
            ) {
                monitorschangedList.push(index);
                if (!gridschangedList.includes(index))
                    gridschangedList.push(index);
            }
        });

        const indexChanged =
            this._priorPrimaryMonitorIndex !== this._primaryMonitorIndex;

        // indexChanged implies monitors have changed
        // monitors changed or index changed implies grids have changed
        // as there may be other actors on the new monitor edge
        const monitorschanged = !!monitorschangedList.length || indexChanged;

        // only the grids have changed, no monitor changes
        const gridschanged = gridschangedList.length
            ? gridschangedList.some(i => !monitorschangedList.includes(i))
            : false;

        // redisplay is needed for sorting and stacking. Icons
        // need to be redisplayed if anything changes - the actual fileList
        // has not changed
        const redisplay = monitorschanged || gridschanged;

        return {
            firstDesktop,
            monitorCountChanged,
            monitorschangedList,
            gridschangedList,
            marginsChanged,
            monitorschanged,
            gridschanged,
            redisplay,
        };
    }

    async _displayDesktopSnapShots() {
        const array = this._desktops.map(
            d => d.displaySnapshot()
        );
        await Promise.all(array).catch(e => logError(e));
    }

    _displayAnimationToLive() {
        this._desktops.forEach(d => d.requestAnimatedRelayout());
    }

    async createGridWindows() {
        // Allow startup with no desktops from constructor
        // even if no desktops are defined when started by the extension
        // desktops can be defined later from updateGridWindows(), dbus
        // activation
        if (!this._desktopList.length ||
            this._desktopList.some(d => {
                return typeof d !== 'object' || d == null;
            }))
            return;

        this._desktops.forEach(desktop => desktop.destroy());
        this._desktops = [];

        this._desktopList.forEach((desktop, desktopIndex) => {
            const desktopName =
                this._asDesktop
                    ? `@!${desktop.x},${desktop.y};BDHF`
                    : `DING ${desktopIndex}`;

            this._desktops.push(
                new DesktopGrid.DesktopGrid({
                    desktopManager: this._desktopManager,
                    desktopName,
                    desktopDescription: desktop,
                    asDesktop: this._asDesktop,
                    hidden: this._hidden,
                    desktopIndex,
                })
            );
        });

        const displayPromises =
            this._desktops.map(desktop => desktop.ensureMapped());

        const allocatedPromises =
            this._desktops.map(d => d.ensureAllocationComplete());

        let safegaurd = 0;
        try {
            const timeoutPromise = new Promise((resolve, reject) => {
                safegaurd = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000,
                    () => {
                        safegaurd = 0;
                        // No useless log noise if windows fail to map
                        // eslint-disable-next-line prefer-promise-reject-errors
                        reject();
                        return GLib.SOURCE_REMOVE;
                    }
                );
            });

            const mapPromises = Promise.all([
                Promise.all(displayPromises),
                Promise.all(allocatedPromises),
            ]);

            await Promise.race([mapPromises, timeoutPromise]);
        } catch (e) {
            // logError(e);
            // if the windows fail to map, we should still proceed
            // and poke the desktop windows later.
            this.show();
        } finally {
            if (safegaurd)
                GLib.source_remove(safegaurd);
        }

        if (this._desktopManager.windowsPromiseResolve)
            this._desktopManager.windowsPromiseResolve(true);
    }

    hide() {
        this._desktops.forEach(desktop => desktop.hide());
        this._hidden = true;
    }

    show() {
        this._hidden = false;
        this._desktops.forEach(desktop => desktop.show());
    }

    queue_draw() {
        this._desktops.forEach(desktop => desktop.queue_draw());
    }

    toggleVisibility() {
        if (this._hidden)
            this.show();
        else
            this.hide();
    }

    toggleWidgetLayers() {
        if (!this._Prefs.showDesktopWidgets)
            return;

        this._desktops.forEach(desktop => desktop.toggleWidgetLayer());
        this._syncShellWidgetLayerRaised();
    }

    lowerWidgetLayers() {
        this._desktops.forEach(desktop => desktop.lowerWidgetContainer());
        this._syncShellWidgetLayerRaised(false);
    }

    raiseWidgetLayers() {
        this._desktops.forEach(desktop => desktop.raiseWidgetContainer());
        this._syncShellWidgetLayerRaised(true);
    }

    _syncShellWidgetLayerRaised(raised = null) {
        const remoteControl = this._desktopManager.DBusUtils
            .RemoteExtensionControl;

        if (!remoteControl.isAvailable)
            return;

        let nextRaised = raised;
        if (nextRaised === null) {
            const desktop = this._desktops[0];
            nextRaised = desktop ? desktop.isWidgetContainerOnTop() : false;
        }

        try {
            remoteControl.setWidgetLayerRaised(nextRaised);
        } catch (e) {
            console.error(e);
        }
    }

    _registerWidgetLayerAction() {
        const action = new Gio.SimpleAction({name: 'toggleWidgetLayer'});
        action.connect('activate', () => {
            this.toggleWidgetLayers();
        });

        action.set_enabled(DesktopWidgetCapability);
        this._desktopManager.mainApp.add_action(action);

        const lowerAction = new Gio.SimpleAction({name: 'lowerWidgetLayer'});
        lowerAction.connect('activate', () => {
            this.lowerWidgetLayers();
        });

        lowerAction.set_enabled(DesktopWidgetCapability);
        this._desktopManager.mainApp.add_action(lowerAction);

        const raiseAction = new Gio.SimpleAction({name: 'raiseWidgetLayer'});
        raiseAction.connect('activate', () => {
            this.raiseWidgetLayers();
        });

        raiseAction.set_enabled(DesktopWidgetCapability);
        this._desktopManager.mainApp.add_action(raiseAction);

        const togglePinnedWidgetsBelowApps = new Gio.SimpleAction({
            name: 'togglePinnedWidgetsBelowApps',
        });
        togglePinnedWidgetsBelowApps.connect('activate', () => {
            const settings = this._Prefs.desktopSettings;
            settings.set_boolean(
                'keep-pinned-widgets-below-apps',
                !settings.get_boolean('keep-pinned-widgets-below-apps')
            );
        });

        const syncPinnedWidgetsAction = () => {
            togglePinnedWidgetsBelowApps.set_enabled(
                DesktopWidgetCapability && this._Prefs.showDesktopWidgets
            );
        };
        syncPinnedWidgetsAction();
        this._Prefs.desktopSettings.connect(
            'changed::show-desktop-widgets',
            syncPinnedWidgetsAction
        );
        this._desktopManager.mainApp.add_action(
            togglePinnedWidgetsBelowApps
        );
    }

    _getPreferredDisplayDesktop() {
        return this._desktopManager.layoutManager.getPreferredDesktop(
            this._desktops, this._primaryMonitorIndex,
            this._Prefs.showOnSecondaryMonitor
        );
    }

    stopDragHandling() {
        this._desktops.forEach(desktop => desktop.stopDragHandling());
    }

    destroyDesktops() {
        this._desktops.forEach(desktop => desktop.destroy());
        this._desktops = [];
    }

    onMutterSettingsChanged() {
        for (let desktop of this._desktops)
            desktop._premultiplied = this._premultiplied;

        this.requestGeometryUpdate();
    }

    // Read-only snapshot, null until the first update:
    // {
    //     previous: null | {primaryMonitorIndex, monitorsByIndex},
    //     current: {
    //         primaryMonitorIndex,
    //         monitorsByIndex: {
    //             [monitorIndex]: {
    //                 monitorIndex,
    //                 globalOrigin: {x, y},
    //                 reportedSize: {width, height},
    //                 logicalSize: {width, height},
    //                 reportedMargins: {top, bottom, left, right},
    //                 scaling: {zoom, scaleFactor},
    //                 physicalMembers: [
    //                     {connector, vendor, product, serial}, ...
    //                 ],
    //             },
    //         },
    //     },
    //     changes: {
    //         profileChanged: boolean, // Key differs from the previous key.
    //         windowResizeMonitorIndices: [monitorIndex, ...],
    //         gridResizeMonitorIndices: [monitorIndex, ...],
    //         windowsRebuilt,
    //     },
    // }
    // Previous has the same shape as current; null on the first update.
    // profileChanged is false on initial selection. It does not indicate
    // whether the destination already has a remembered layout.
    // Resize lists contain runtime monitor indices, not array positions.
    // Reported margins retain hidden-edge encoding and exclude grid padding.
    // Profile selection and transformation policy remain in LayoutManager.
    get geometryTransition() {
        return this._geometryTransition;
    }

    get desktops() {
        return this._desktops;
    }

    get desktopList() {
        return this._desktopList;
    }

    get primaryMonitorIndex() {
        return this._primaryMonitorIndex;
    }

    get primaryMonitor() {
        return this._primaryScreen;
    }

    get primaryIndex() {
        return this._primaryIndex;
    }

    get priorDesktopList() {
        return this._priorDesktopList;
    }

    get priorPrimaryMonitorIndex() {
        return this._priorPrimaryMonitorIndex;
    }

    get differentZooms() {
        return this._differentZooms;
    }

    get preferredDisplayDesktop() {
        return this._getPreferredDisplayDesktop();
    }
};
