/* DING: Desktop Icons New Generation for GNOME Shell
 *
 * Gtk4 Port Copyright (C) 2022-26 Sundeep Mediratta (smedius@gmail.com)
 * Copyright (C) 2019 Sergio Costas (rastersoft@gmail.com)
 * Based on code original (C) Carlos Soriano
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
    AppChooser,
    AskRenamePopup,
    AutoAr,
    ClipboardManager,
    DesktopDropOperations,
    DesktopMenu,
    DesktopMonitor,
    DragManager,
    DropSession,
    FileItemMenu,
    GnomeShellDragDrop,
    ShortcutManager,
    ShowErrorPopup,
    StackItem,
    TemplatesScriptsManager,
    WindowManager,
    WidgetManager
} from '../dependencies/localFiles.js';

import {Adw, Gtk, Gdk, Gio, GLib, GLibUnix} from '../dependencies/gi.js';
import {_} from '../dependencies/gettext.js';
import {LayoutManager} from './layoutManager.js';

export {DesktopManager};

const DesktopManager = class {
    constructor(Data, Utils, desktopList, codePath, asDesktop, primaryIndex) {
        // Inherit
        this.mainApp = Data.mainApp;
        this.codePath = codePath;
        this._asDesktop = asDesktop;
        if (asDesktop) {
            // Don't close the application if there are no desktops
            this.mainApp.hold();
            this._hold_active = true;
        }

        this.GnomeShellVersion = Data.gnomeversion;

        this.uuid = Data.uuid;

        // Init and import Scripts and classes
        this.DesktopIconsUtil = Utils.DesktopIconsUtil;
        this.FileUtils = Utils.FileUtils;
        this.Enums = Data.Enums;
        this.DBusUtils = Utils.DBusUtils;
        this.dbusManager = Utils.DBusUtils.dbusManagerObject;
        this.Prefs = Utils.Preferences;
        this.showErrorPopup = ShowErrorPopup;
        this.templatesScriptsManager = TemplatesScriptsManager;
        this.GnomeShellDragDrop = GnomeShellDragDrop;
        this.DropSession = DropSession;
        this.appChooser = AppChooser;
        this.ThumbnailLoader = Utils.ThumbnailLoader;

        // init methods
        this.dropOperations =
            new DesktopDropOperations.DesktopDropOperations(this);
        this.dragManager = new DragManager.DragManager(this);
        this.clipboardManager = new ClipboardManager(this);
        this.layoutManager = new LayoutManager(this.DesktopIconsUtil);
        this.windowManager = new WindowManager.WindowManager(this,
            desktopList,
            asDesktop,
            primaryIndex
        );
        this.desktopMonitor = new DesktopMonitor.DesktopMonitor(this);

        try {
            this.layoutManager.updateMonitorConfiguration(desktopList, {});
        } catch (error) {
            console.error(error, 'Failed to initialize layout profile');
        }

        this.autoAr = new AutoAr.AutoAr(this);
        this.fileItemMenu = new FileItemMenu.FileItemMenu(this);
        this.fileItemActions = new FileItemMenu.FileItemActions(this);
        this.desktopActions = new DesktopMenu.DesktopActions(this);
        this.desktopMenuManager = new DesktopMenu.DesktopBackgroundMenu(this);
        this.Prefs.init(this);
        this.shortcutManager = new ShortcutManager(this);
        this.widgetManager = new WidgetManager.WidgetManager(this);
        this.mainApp.getDialogParentWindow =
            this.getDialogParentWindow.bind(this);

        // Init Variables
        this._clickX = null;
        this._clickY = null;
        this._compositeStackList = null;
        this._displayList = [];
        this._desktopUpdateQueue = Promise.resolve();
        // Track last seen keyboard modifier state so accelerators can query it
        this._lastModifierState = 0;
        this.ignoreKeys = this.Enums.IgnoreKeys.map(_k => Gdk[_k]);

        // setup gracefull termination
        if (this._asDesktop) {
            this._sigtermID = GLibUnix.signalAdd(
                GLib.PRIORITY_DEFAULT,
                15,
                () => {
                    GLib.source_remove(this._sigtermID);
                    this.terminateProgram();
                    if (this._hold_active) {
                        this.mainApp.release();
                        this._hold_active = false;
                    }
                    return false;
                }
            );
        }
        this._syncStartupDesktop().catch(e => logError(e));
    }

    getDialogParentWindow(window = null) {
        const activeWindow = window ?? this.mainApp.get_active_window();
        if (!activeWindow)
            return null;

        if (this.widgetManager) {
            return this.widgetManager.resolveSurfaceWindowFromActiveWindow(
                activeWindow
            );
        }

        return activeWindow;
    }

    runSerializedDesktopMutation(updateFn) {
        // Run desktop updates one at a time. Each call keeps its own turn, so
        // this serializes updates but does not merge them into a single call.
        //
        // Callers must pass a function with the correct `this` binding already
        // applied; `then()` invokes it directly.
        const nextUpdate = this._desktopUpdateQueue.then(updateFn);

        // Keep the queue chain alive even if one update fails; callers still
        // get the rejection from `nextUpdate`.
        this._desktopUpdateQueue = nextUpdate.catch(() => {});

        return nextUpdate;
    }

    _runSerializedDrawDesktop(fileList, layoutRequest = {}) {
        return this.runSerializedDesktopMutation(async () => {
            if (this.windowsPromiseResolve || !fileList)
                return;

            layoutRequest = this.layoutManager.selectLayoutAdaptations(
                layoutRequest, this._desktops, this.Prefs
            );
            await this._drawDesktop(fileList, layoutRequest);
            this._rememberSettledDesktopLayout(layoutRequest);
        });
    }

    async _syncStartupDesktop() {
        // startup in a particular order
        // First create and make sure windows are created
        const windowscreated = new Promise(resolve => {
            this.windowsPromiseResolve = resolve;
            this.windowManager.createGridWindows().catch(e => logError(e));
            // If this desktop List is null, ask for a new one
            this.windowManager.requestGeometryUpdate();
        });

        // Monitor is attached, windows are created with proper geometry
        // Profile is loaded, now we can proceed.
        await Promise.all([
            windowscreated.catch(e => logError(e)),
            this.layoutManager.waitForProfiles(),
        ]);

        // Now we can actually display errors, so check for them
        // Ensure that there is a 'Desktop' folder set and it exists
        // Verify if Gnome Files is available and executable, otherwise warn
        // Confirm Gnome Files is registered with xdg-utils
        // to handle inode/directory
        this._performSanityChecks().catch(e => logError(e));

        // Initial placement recalculates runtime positions before reconciling
        // new files into the remembered layout.
        const initialRead = true;

        // prior fileList, even if triggered through desktopdir changes
        // will not be displayed as windows were not there.
        const fileList = await this.desktopMonitor.getFileList();

        // This is no longer needed, if true it blocks and all updates.
        this.windowsPromiseResolve = null;

        const layoutRequest = {
            operationFlags: {initialRead},
            geometryTransition: this.windowManager.geometryTransition,
        };

        await this.runSerializedDesktopMutation(async () => {
            let preparedRequest = this.layoutManager.selectLayoutAdaptations(
                layoutRequest, this._desktops, this.Prefs
            );
            preparedRequest = {
                ...preparedRequest,
                widgetPlacements:
                    this.layoutManager.createWidgetAffinePlacements(
                        this._desktops, preparedRequest.sourceLayout,
                        preparedRequest.sourceMonitorIndices
                    ),
            };

            await Promise.all([
                this._drawDesktop(fileList, preparedRequest),
                this._startWidgetDisplay({
                    ...preparedRequest,
                    operationFlags: {redisplay: true},
                }),
            ]);
            this._rememberSettledDesktopLayout(preparedRequest);
        }).catch(e => logError(e));
        // First intitiation complete, valid file read from
        // desktopdir, even if a prior fileList was read, the
        // forced new read reconciles settled positions with layout memory.

        // force a queue draw of all windows now that we have drawn the desktop,
        // and poke mutter to map the meta window.
        this.windowManager.queue_draw();
    }

    async _performSanityChecks() {
        // show error if monitor frame buffer scaling is not enabled first,
        //  as windows may be awry
        if (this.windowManager.differentZooms &&
            !this.fractionalScaling &&
            !this._framebufferWarningDone) {
            const header = _('Monitor Frame Buffer Scaling is not enabled');
            const text = _('Multiple monitors with different zoom settings, recommend per monitor framebuffer scaling.\n\nPlease enable in Mutter Dconf Settings');
            // show notification as well as error dialog as windows may
            //  not be postioned correctly
            this.dbusManager.doNotify(header, text);
            this._framebufferWarningDone = true;

            const window = this.getDialogParentWindow();
            const dialog = new Adw.AlertDialog();
            dialog.set_body_use_markup(true);
            dialog.set_heading_use_markup(true);
            dialog.set_heading(header);
            const secondaryText = _('Multiple monitors with different zoom settings.\n\nEnable per monitor framebuffer scaling in Mutter Dconf Settings?');
            dialog.set_body(secondaryText);
            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('enable', _('Enable'));
            dialog.set_close_response('cancel');
            dialog.set_default_response('enable');
            dialog.set_response_appearance(
                'enable', Adw.ResponseAppearance.SUGGESTED);
            dialog.set_response_appearance(
                'cancel', Adw.ResponseAppearance.DEFAULT);
            dialog.set_prefer_wide_layout(true);
            const runDialog = new Promise(resolve => {
                dialog.choose(window, null, (actor, asyncResult) => {
                    const response = actor.choose_finish(asyncResult);
                    if (response === 'enable')
                        this.Prefs.fractionalScaling = true;
                    dialog.close();
                    resolve(response);
                });
            });
            await runDialog;
        }

        const fileType = this.desktopDir.query_file_type(
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null);
        if (fileType === Gio.FileType.SYMBOLIC_LINK) {
            const header = _('Can Not Show the Desktop');
            // TRANSLATORS: {desktop} folder path automatically inserted
            const text = _('The Desktop folder {desktop} is a Symbolic Link\n\nPlease set the Desktop Folder to a real Folder');
            const errorDialog = this.showError(
                header,
                text.replace('{desktop}', this.desktopDir.get_path())
            );
            await errorDialog.run();
            this._desktops.forEach(d => d.setErrorState());
        } else if (fileType !== Gio.FileType.DIRECTORY) {
            const header = _('Can Not Show the Desktop');
            // TRANSLATORS: {desktop} folder path automatically inserted
            const text = _('The Desktop folder {desktop} does not exist, or is not a Directory\n\nCheck your xdg-utils installation and set the correct Desktop Folder');
            const errorDialog = this.showError(
                header,
                text.replace('{desktop}', this.desktopDir.get_path())
            );
            await errorDialog.run();
            this._desktops.forEach(d => d.setErrorState());
        }

        const inodeHandlers = Gio.AppInfo.get_all_for_type('inode/directory');
        if (!GLib.find_program_in_path('nautilus')) {
            const header = _('GNOME Files not found');
            const text = _('The GNOME Files application is required by Gtk4 Desktop Icons NG.');
            const errorDialog = this.showError(header, text);
            await errorDialog.run();
        }

        if (!inodeHandlers.length) {
            const helpURL = 'https://gitlab.com/smedius/desktop-icons-ng/-/issues/73';
            const header = _('There is no default File Manager');
            const text = _('There is no application that handles mimetype "inode/directory"');
            const errorDialog = this.showError(header, text, helpURL);
            await errorDialog.run();
        }

        if (!inodeHandlers.some(a => a.get_id() === 'org.gnome.Nautilus.desktop')) {
            const helpURL = 'https://gitlab.com/smedius/desktop-icons-ng/-/issues/73';
            const header = _('Gnome Files is not registered as a File Manager');
            const text = _('The Gnome Files application is not programmed to open Folders!\nCheck your xdg-utils installation\nCheck Gnome Files .desktop File installation');
            const errorDialog = this.showError(header, text, helpURL);
            await errorDialog.run();
        }
    }

    showError(text, secondaryText, helpURL = null, timeout = 0,
        parentWindow = null) {
        const window = this.getDialogParentWindow(parentWindow);
        const errorDialog = new ShowErrorPopup.ShowErrorPopup(
            text,
            secondaryText,
            this.DesktopIconsUtil.waitDelayMs,
            helpURL,
            window
        );

        if (timeout)
            errorDialog.runAutoClose(timeout);

        return errorDialog;
    }

    closeFocusStealingWindows() {
        this.desktopActions?.preferencesWindow?.close();
        this.shortcutManager?.closeShortcutViewer();
    }

    terminateProgram() {
        this.layoutManager.stopLayoutManager();
        this._stopWidgetDisplay();
        this.windowManager.stopDragHandling();
        this.clipboardManager.destroy();
        this.dragManager.destroy();
        this.dropOperations.destroy();
        this.desktopMonitor.stopMonitoring();

        if (this._dbusGeometryIface)
            this._dbusGeometryIface.unexport();

        if (this._compositeStackList && this._compositeStackList.length) {
            this._displayList.forEach(f => {
                if (f.isStackMarker)
                    f.onDestroy();
            });
            this._compositeStackList.forEach(f => f.onDestroy());
        } else {
            this._displayList.forEach(f => f.onDestroy());
        }

        this.windowManager.destroyDesktops();
    }

    // Keyboard and Mouse Events

    onPressButton(X, Y, x, y, button, shiftPressed, controlPressed) {
        this._clickX = Math.floor(X);
        this._clickY = Math.floor(Y);

        // Left Click
        if (button === 1) {
            if (!shiftPressed && !controlPressed) {
                // clear selection
                this.unselectAll();
            }
            this.dragManager.startRubberband(X, Y);
        }
    }

    async onReleaseButton(X, Y, x, y, button, isShift, isCtrl, grid) {
        // Right Click
        if (button === 3) {
            await this.desktopMenuManager
                .showDesktopMenu(x, y, grid)
                .catch(e => logError(e));
        }
    }

    onLongPressButton(_X, _Y, _x, _y, button, _isShift, _isCtrl, _grid) {
        if (button === 3)
            this.mainApp.activate_action('displayShellBackgroundMenu', null);
    }

    async onWidgetDisplayChanged() {
        if (this.Prefs.showDesktopWidgets) {
            await this._startWidgetDisplay();
            this.reconcileLayout();
        } else {
            this._stopWidgetDisplay();
        }
    }

    _startWidgetDisplay(layoutRequest = {
        operationFlags: {redisplay: true},
    }) {
        return this.widgetManager
        .startWidgetDisplay(this._desktops, layoutRequest);
    }

    _stopWidgetDisplay() {
        this.widgetManager.stopWidgetDisplay();
    }

    onKeyPress(keyval, keycode, state, grid) {
        this.keyEventGrid = grid;
        if (this.popupmenu || this.fileItemMenu.popupmenu)
            return true;

        if (this.ignoreKeys.includes(keyval))
            return true;

        let key = String.fromCharCode(Gdk.keyval_to_unicode(keyval));
        if (this.keypressTimeoutID && this.searchString)
            this.searchString = this.searchString.concat(key);
        else
            this.searchString = key;

        if (this.searchString !== '') {
            let found = this._scanForFiles(this.searchString, false);
            if (found) {
                if ((this.getNumberOfSelectedItems() >= 1) &&
                    !this.keypressTimeoutID) {
                    const secondaryText = null;
                    const helpURL = null;
                    const timeoutClose = 2000; // In ms
                    this.showError(
                        _('Clear current selection before new search'),
                        secondaryText,
                        helpURL,
                        timeoutClose
                    );
                    return true;
                }
                this.searchEventTime = GLib.get_monotonic_time();
                if (!this.keypressTimeoutID) {
                    this.keypressTimeoutID =
                        GLib.timeout_add(
                            GLib.PRIORITY_DEFAULT,
                            1000,
                            () => {
                                if (GLib.get_monotonic_time() -
                                    this.searchEventTime < 1500000)
                                    return true;

                                this.searchString = null;
                                this.keypressTimeoutID = null;

                                if (this._findFileWindow) {
                                    this._findFileWindow
                                        .response(Gtk.ResponseType.OK);
                                }

                                return false;
                            });
                }
                this.findFiles(this.searchString);
            }
            return true;
        } else {
            return false;
        }
    }

    updateModifierState(state) {
        // cache modifier state for use by accelerator-driven handlers
        this._lastModifierState = state;
    }

    clearModifierState() {
        // reset cached modifier state
        this._lastModifierState = 0;
    }

    closePopUps() {
        if (this._renameWindow) {
            this._renameWindow.close();
            return true;
        }
        if (this.dialogCancellable) {
            this.dialogCancellable.cancel();
            this.dialogCancellable = null;
            return true;
        }
        return false;
    }

    clearAllLayersFromGrids(layoutRequest = {}) {
        // Icons: clear from all grids
        this._displayList.forEach(x => x.removeFromGrid());

        // Widgets: clear from all grids
        this.widgetManager.clearFromGrids(layoutRequest);
    }

    async applyDesktopLayoutChange(layoutRequest) {
        this._performSanityChecks();

        // Prepare both paths from the same saved profile before display work.
        layoutRequest = this.layoutManager.selectLayoutAdaptations(
            layoutRequest, this._desktops, this.Prefs
        );
        layoutRequest = {
            ...layoutRequest,
            widgetPlacements: this.layoutManager.createWidgetAffinePlacements(
                this._desktops, layoutRequest.sourceLayout,
                layoutRequest.sourceMonitorIndices
            ),
        };

        await Promise.all([
            this._reFrameDesktop(layoutRequest),
            this.widgetManager.applyLayoutChange(
                this._desktops, layoutRequest
            ),
        ]);
        this._rememberSettledDesktopLayout(layoutRequest);
    }


    _rememberSettledDesktopLayout(layoutRequest = null) {
        const intentionalIconUris = this._displayList.filter(fileItem =>
            fileItem.pendingPlacementReason === 'user-drop'
        ).map(fileItem => fileItem.uri);

        const operationFlags = layoutRequest?.operationFlags ?? {};
        let capturedIconUris = intentionalIconUris;

        if (this.Prefs.keepStacked)
            capturedIconUris = [];
        else if (operationFlags.snapToGrid)
            capturedIconUris = this._displayList.map(fileItem => fileItem.uri);

        if (layoutRequest?.individualIconPositions) {
            this.layoutManager.rememberAdaptedLayout(
                this.layoutManager.captureLayout(
                    this._desktops, this.widgetManager.exportPlacements(),
                    layoutRequest.individualIconPositions, false, [],
                    !this.Prefs.freePositionIcons
                )
            );
        } else if (!this.Prefs.keepStacked && (!layoutRequest ||
            this.Prefs.keepArranged || operationFlags.applyAffine ||
            operationFlags.applyWebCola || operationFlags.applyHungarian)) {
            this.layoutManager.rememberAdaptedLayout(
                this.captureLayout(capturedIconUris)
            );
        }

        if (this.reconcileLayout(capturedIconUris)) {
            for (const fileItem of this._displayList) {
                if (intentionalIconUris.includes(fileItem.uri))
                    fileItem.pendingPlacementReason = null;
            }
        }
    }

    // Destktop Icon Placement and Display
    // ********************************************************************** */

    _removeAllFilesFromGrids() {
        for (let fileItem of this._displayList)
            fileItem.removeFromGrid({callOnDestroy: true});

        this._displayList = [];
    }

    _clearAllFilesFromGrids() {
        for (let fileItem of this._displayList)
            fileItem.removeFromGrid({callOnDestroy: false});

        this._displayList = [];
    }

    async _drawDesktop(fileList, layoutRequest) {
        if (this.windowsPromiseResolve || !fileList)
            return;

        const {operationFlags} = layoutRequest;
        const selectedFiles = this.getCurrentSelectionAsUri();
        const displayList = [...fileList];

        //* Remove all files from the grids just before placing new files to
        // prevent flickering icons *//
        if (operationFlags.initialRead)
            this._removeAllFilesFromGrids();
        else
            this._clearAllFilesFromGrids();
        this._displayList = displayList;

        this.layoutManager.recordDropPositions(displayList, this._desktops);

        // Ordinary reads seed profile positions here. Geometry transitions
        // restore them in LayoutManager after adaptation and cell preparation.
        if (this.Prefs.keepArranged &&
            operationFlags.restorePositions && !operationFlags.monitorschanged &&
            !operationFlags.gridschanged) {
            this.layoutManager.applyRememberedIconPositions(
                displayList, this._desktops
            );
        }

        this._placeAllFilesOnGrids(layoutRequest);

        const drawComplete = displayList.map(async fileItem => {
            // Start icon loading early so late loads settle before first paint.
            await fileItem.updateIcon();
            if (selectedFiles) {
                if (selectedFiles.includes(fileItem.uri))
                    fileItem.setSelected();
            }
            // Wait for either snapshot placement or the not-shown fallback.
            await fileItem.iconPlaced;
        });

        await Promise.all([...drawComplete]);

        //* Desktop draw/paint is now complete *//
        //* Reposition open Menus, renameFileItem pop up's **//
        //* Any task after complete desktop draw can now be done *//
        this._refreshMenus();
    }

    _refreshMenus() {
        if ((this.newItemDoRename && this.newItemDoRename.size) ||
            this.fileItemMenu.popupmenu ||
            this.activeFileItem) {
            let activeItem = false;
            let newItemDoRename = false;

            this._displayList.forEach(f => {
                if (this.activeFileItem &&
                    (f.fileName === this.activeFileItem.fileName))
                    this.activeFileItem = activeItem = f;

                if (this.newItemDoRename &&
                    this.newItemDoRename.has(f.fileName))
                    newItemDoRename = f;
            });

            if (this._renameWindow)
                this._renameWindow.close();

            if (newItemDoRename) {
                newItemDoRename.setSelected();
                const allowReturnOnSameName = true;
                this.doRename(newItemDoRename, allowReturnOnSameName)
                .catch(e => logError(e));
            }

            if (this.fileItemMenu.popupmenu) {
                if (!activeItem)
                    this.fileItemMenu.popupmenu.popdown();
            }

            if (!activeItem)
                this.activeFileItem = null;
        }
    }

    _placeAllFilesOnGrids(layoutRequest = {}) {
        const {operationFlags = {}} = layoutRequest;

        if (this.Prefs.keepStacked) {
            const individualFiles = operationFlags.redisplay &&
                this._compositeStackList
                ? this._compositeStackList : this._displayList;

            layoutRequest.individualIconPositions =
                this.layoutManager.prepareStackedIconPositions(
                    individualFiles,
                    this._getIconPlacementContext(layoutRequest)
                );
            // Stack presentation must not overwrite these individual records.
            this._doStacks({...operationFlags});
            return;
        }
        if (this.Prefs.keepArranged) {
            this._doSorts(operationFlags);
            return;
        }
        this.layoutManager.placeFilesOnDesktop(
            this._displayList, this._getIconPlacementContext(layoutRequest)
        );
    }

    _addFilesToDesktop(fileList) {
        this.layoutManager.placeFilesOnDesktop(
            fileList, this._getIconPlacementContext()
        );
    }

    discardPendingDropDestinations() {
        // Pending operations may not have produced a file item yet.
        for (const name of Object.keys(this.positionsForNewFiles))
            delete this.positionsForNewFiles[name];

        for (const fileItem of new Set([
            ...this.desktopMonitor.fileList, ...this._displayList,
            ...this._compositeStackList ?? [],
        ])) {
            fileItem.dropCoordinates = null;

            if (fileItem.pendingPlacementReason === 'user-drop')
                fileItem.pendingPlacementReason = null;
        }
    }

    captureLayout(editedIconUris = []) {
        const originalIcons = this._compositeStackList ??
            (this.Prefs.keepArranged ? this._displayList : null);

        return this.layoutManager.captureLayout(
            this._desktops, this.widgetManager.exportPlacements(),
            originalIcons, this.Prefs.keepStacked ||
                Boolean(this._compositeStackList), editedIconUris,
            !this.Prefs.freePositionIcons
        );
    }

    rememberLayout() {
        this.layoutManager.reconcileLayout(this.captureLayout());
    }

    reconcileLayout(iconUris = [], widgetIds = [], authority = 'user') {
        if (this.windowsPromiseResolve)
            return false;

        try {
            const snapshot = this.captureLayout(iconUris);

            if (!snapshot)
                return false;

            this.layoutManager.reconcileLayout(
                snapshot, iconUris, widgetIds, authority
            );
            return true;
        } catch (error) {
            console.error(error, 'Failed to reconcile settled layout');
            return false;
        }
    }

    async restoreLayout() {
        await this.runSerializedDesktopMutation(() => {
            const plan = this.layoutManager.createRestorePlan(this._desktops);

            if (!plan)
                return;

            if (plan.unresolvedMonitors.length)
                throw new Error('Exact restoration has unresolved monitors');

            const originalFiles = this._compositeStackList ?? this._displayList;

            const newFiles = originalFiles.filter(fileItem =>
                !Object.hasOwn(plan.icons, fileItem.uri));

            for (const fileItem of newFiles)
                fileItem.savedCoordinates = null;

            // Remove the current presentation, including generated markers.
            // Keep the original file objects, even when they were hidden.
            for (const fileItem of new Set([
                ...this._displayList, ...originalFiles,
            ])) {
                fileItem.removeFromGrid({callOnDestroy: false});

                if (!originalFiles.includes(fileItem) && fileItem.isStackMarker)
                    fileItem.onDestroy();
            }

            this._displayList = originalFiles;
            this._compositeStackList = null;

            this.layoutManager.restoreIconPlacements(
                originalFiles, this._desktops, plan.icons
            );

            // Occupy remembered positions first; ordinary placement then finds
            // space for newcomers. Stacked newcomers wait until unstacking.
            if (!this.Prefs.keepStacked && newFiles.length)
                this._addFilesToDesktop(newFiles);


            // Stack initialization now saves the restored original positions.
            // Arrangement affects presentation, never the remembered snapshot.
            if (this.Prefs.keepStacked)
                this._doStacks({redisplay: true});
            else if (this.Prefs.keepArranged)
                this._doSorts({redisplay: true});

            this.widgetManager.restorePlacements(plan.widgets);

            if (newFiles.length) {
                const intentionalIconUris = newFiles.filter(fileItem =>
                    fileItem.pendingPlacementReason === 'user-drop'
                ).map(fileItem => fileItem.uri);

                this.reconcileLayout(intentionalIconUris);
            }
        });
    }

    _getIconPlacementContext(layoutRequest = {}) {
        // A layout request describes the work: operationFlags and geometry.
        // Placement context adds the surfaces and preferences to do that work.
        // Missing flags mean ordinary placement; missing geometry means this
        // request is not a monitor update.
        return {
            sourceLayout: layoutRequest.sourceLayout,
            sourceMonitorIndices: layoutRequest.sourceMonitorIndices,
            operationFlags: layoutRequest.operationFlags ?? {},
            geometryTransition: layoutRequest.geometryTransition ?? null,
            desktops: this._desktops,
            primaryMonitorIndex: this.windowManager.primaryMonitorIndex,
            preferences: {
                startCorner: [...this.Prefs.StartCorner],
                addVolumesOpposite: this.Prefs.AddVolumesOpposite,
                freePositionIcons: this.Prefs.freePositionIcons,
                keepArranged: this.Prefs.keepArranged,
                keepStacked: this.Prefs.keepStacked,
                sortSpecialFolders: this.Prefs.sortSpecialFolders,
                showOnSecondaryMonitor: this.Prefs.showOnSecondaryMonitor,
            },
        };
    }

    _unstack() {
        if (this._compositeStackList) {
            const layoutRequest = this.layoutManager.selectLayoutAdaptations(
                {operationFlags: {unstack: true}}, this._desktops, this.Prefs
            );

            this._displayList.forEach(f => {
                f.removeFromGrid();
                if (f.isStackMarker)
                    f.onDestroy();
            });
            this._displayList = this._compositeStackList;

            for (const fileItem of this._displayList)
                fileItem.savedCoordinates = null;

            this._compositeStackList = null;

            if (this.sortingSubMenu && this.sortingMenu) {
                this.sortingSubMenu.prepend_item(
                    this.keepArrangedMenuItem
                );
                this.sortingMenu.prepend_item(this.cleanUpMenuItem);
            }

            if (this.Prefs.keepArranged) {
                this.layoutManager.applyRememberedIconPositions(
                    this._displayList, this._desktops
                );
                this._doSorts();
            } else {
                this._placeAllFilesOnGrids(layoutRequest);
            }

            // Unknown arrivals establish individual positions after placement.
            this._rememberSettledDesktopLayout(layoutRequest);
        }
    }

    _makeStackTopMarkerFolder(type, list) {
        let stackAttribute = type.split('/')[1];
        let fileItem = new StackItem.StackItem(
            this,
            stackAttribute,
            type,
            this.Enums.FileType.STACK_TOP
        );

        list.push(fileItem);
    }

    _sortAllFilesFromGridsByKindStacked(opts = {redisplay: false}) {
        if (this._compositeStackList && opts.redisplay) {
            this._displayList.forEach(f => {
                if (f.isStackMarker)
                    f.onDestroy();
            });
            this._displayList = this._compositeStackList;
        }

        const stackGroups =
            this.layoutManager.groupFilesForStacking(this._displayList);
        const {otherFiles} = stackGroups;
        const stackTopMarkerFolderList = [];

        for (let item of otherFiles) {
            if (!item.stackUnique) {
                this._makeStackTopMarkerFolder(
                    item.attributeContentType,
                    stackTopMarkerFolderList
                );
            }

            if (item.stackUnique)
                stackTopMarkerFolderList.push(item);

            item.updateIcon()
            .catch(e => console.error(e, 'Error loading stackMarker icon'));
        }

        const newFileList = this.layoutManager.orderStackedFiles(
            stackGroups,
            stackTopMarkerFolderList,
            this.Prefs.UnstackList,
            this.Prefs.sortOrder,
            this.Enums.SortOrder
        );

        if (this._compositeStackList)
            this._compositeStackList = this._displayList;

        this._displayList = newFileList;
    }


    _reassignFilesToDesktop() {
        this._displayList = this.layoutManager.reassignFilesOnDesktop(
            this._displayList, this._getIconPlacementContext()
        );
    }

    // Desktop Manager Main methods
    // ********************************************************************** */


    findFiles(text) {
        if (this._findFileWindow) {
            this._findFileWindow.present();
            return;
        }

        const activeWindow = this.getDialogParentWindow();
        this._findFileWindow = new Gtk.Dialog({
            use_header_bar: true,
            resizable: false,
        });
        this._findFileButton =
            this._findFileWindow.add_button(_('OK'), Gtk.ResponseType.OK);
        this._findFileButton.sensitive = false;
        this._findFileWindow.add_button(_('Cancel'), Gtk.ResponseType.CANCEL);
        this._findFileWindow.set_modal(true);
        this._findFileWindow.set_title(_('Find Files on Desktop'));
        const modal = true;
        this.DesktopIconsUtil
        .windowHidePagerTaskbarModal(this._findFileWindow, modal);
        this._findFileWindow.set_transient_for(activeWindow);
        let contentArea = this._findFileWindow.get_content_area();
        this._findFileTextArea = new Gtk.Entry();
        this._findFileTextArea.set_margin_top(5);
        this._findFileTextArea.set_margin_bottom(5);
        this._findFileTextArea.set_margin_start(5);
        this._findFileTextArea.set_margin_end(5);
        contentArea.append(this._findFileTextArea);
        contentArea.set_homogeneous(true);
        contentArea.set_baseline_position(Gtk.BaselinePosition.CENTER);

        this._findFileTextArea.connect('activate', () => {
            if (this._findFileButton.sensitive)
                this._findFileWindow.response(Gtk.ResponseType.OK);
        });

        this._findFileTextArea.connect('changed', () => {
            let context = this._findFileTextArea.get_style_context();

            if (this._scanForFiles(this._findFileTextArea.text, true)) {
                this._findFileButton.sensitive = true;

                if (context.has_class('not-found'))
                    context.remove_class('not-found');
            } else {
                this._findFileButton.sensitive = false;
                this._findFileTextArea.error_bell();

                if (!context.has_class('not-found'))
                    context.add_class('not-found');
            }

            this.searchEventTime = GLib.get_monotonic_time();
        });

        this._findFileTextArea.grab_focus_without_selecting();

        if (text) {
            this._findFileTextArea.set_text(text);
            this._findFileTextArea.set_position(text.length);
        } else {
            this._scanForFiles(null);
        }

        this._findFileWindow.show();

        this.mainApp.activate_action('textEntryAccelsTurnOff', null);

        this._findFileWindow.connect('close', () => {
            this._findFileWindow.response(Gtk.ResponseType.CANCEL);
        });

        this._findFileWindow.connect('response', (actor, retval) => {
            if (retval === Gtk.ResponseType.CANCEL)
                this.unselectAll();

            this.mainApp.activate_action('textEntryAccelsTurnOn', null);
            this._displayList.forEach(f => (f.opacity = 1));
            this._findFileWindow.destroy();
            this._findFileWindow = null;
        });
    }

    _scanForFiles(text, setselected) {
        let found = [];
        if (text && (text !== '')) {
            const lowerCaseText = text.toLowerCase();
            found =
                this._displayList.filter(
                    f => {
                        const lowerCaseFilename = f.fileName.toLowerCase();
                        const lowerCaseLabel = f.labelText.toLowerCase();

                        return (
                            lowerCaseFilename.includes(lowerCaseText) ||
                            lowerCaseLabel.includes(lowerCaseText)
                        );
                    }
                );
        }

        if (found.length !== 0) {
            if (setselected) {
                this.unselectAll();
                const notfound = this._displayList.filter(
                    f => !found.includes(f)
                );
                found.forEach(f => {
                    f.setSelected();
                    f.opacity = 1;
                });
                notfound.forEach(f => (f.opacity = 0.2));
            }
            return true;
        } else {
            this.unselectAll();
            return false;
        }
    }

    async sortAllFilesFromGridsByPosition() {
        if (this.Prefs.keepArranged)
            return;

        await this.runSerializedDesktopMutation(() => {
            this._sortAllFilesFromGridsByPosition();

            this._rememberArrangedLayout();
        });
    }

    _rememberArrangedLayout() {
        if (this.Prefs.keepStacked || this._compositeStackList)
            return;

        try {
            const arrangedFiles = this._displayList.filter(item =>
                this.Prefs.sortSpecialFolders || !item.isSpecial);

            // Explicit arrangement accepts rendered positions. Ordinary
            // capture continues to use the underlying original composition.
            const snapshot = this.layoutManager.captureLayout(
                this._desktops, this.widgetManager.exportPlacements(),
                null, false, [], !this.Prefs.freePositionIcons
            );

            if (!snapshot)
                return;

            this.layoutManager.reconcileLayout(snapshot,
                arrangedFiles.map(item => item.uri));
            this.layoutManager.applyRememberedIconPositions(
                arrangedFiles, this._desktops
            );
        } catch (error) {
            console.error(error, 'Failed to remember requested arrangement');
        }
    }

    _sortAllFilesFromGridsByPosition() {
        this._displayList.forEach(f => f.removeFromGrid({
            callOnDestroy: false,
        }));
        this._displayList = this.layoutManager.cleanUpFilesOnDesktop(
            this._displayList, this._getIconPlacementContext()
        );
    }

    _doSorts(opts = {redisplay: false}) {
        if (opts.redisplay)
            this._displayList.forEach(f => f.removeFromGrid());

        const orderedFiles = this.layoutManager.orderFiles(
            this._displayList, this.Prefs.sortOrder, this.Enums.SortOrder
        );

        if (orderedFiles === null) {
            this._addFilesToDesktop(this._displayList);
            return;
        }

        this._displayList = orderedFiles;
        this._reassignFilesToDesktop();
    }


    _doStacks(opts = {redisplay: false}) {
        if (opts.redisplay) {
            for (let fileItem of this._displayList)
                fileItem.removeFromGrid();
        }

        if (!this._compositeStackList) {
            this._compositeStackList = [];
            if (this.sortingSubMenu && this.sortingMenu) {
                this.sortingSubMenu.remove(0);
                this.sortingMenu.remove(0);
            }
            opts.redisplay = false;
        }

        this._sortAllFilesFromGridsByKindStacked(opts);

        this._reassignFilesToDesktop();
    }

    unselectAll() {
        this._displayList.forEach(f => {
            f.unsetSelected();
            f.keyboardUnSelected();
            f.opacity = 1;
        });
        this.desktopActions.lastAnchorSelected = null;
        this.fileItemMenu.activeFileItem = null;
    }

    selectionCanBeRepositioned() {
        if (!this.Prefs.keepArranged && !this.Prefs.keepStacked)
            return true;
        if (this.Prefs.sortSpecialFolders)
            return false;
        const movableSelection = this.getCurrentSelection()
            ?.filter(file => !file.isSpecial) ?? [];
        return movableSelection.length < 1;
    }

    getCurrentSelection() {
        const selectedList = this._displayList.filter(f => f.isSelected);

        if (selectedList.length)
            return selectedList;

        return null;
    }

    getCurrentSelectionAsUri() {
        return this.getCurrentSelection()?.map(f => f.uri);
    }

    getNumberOfSelectedItems() {
        const count = this.getCurrentSelection();

        if (count)
            return count.length;

        return 0;
    }

    checkIfSpecialFilesAreSelected() {
        for (let item of this._displayList) {
            if (item.isSelected && item.isSpecial)
                return true;
        }

        return false;
    }

    checkIfDirectoryIsSelected() {
        for (let item of this._displayList) {
            if (item.isSelected && item.isDirectory)
                return true;
        }

        return false;
    }

    async doRename(fileItem, allowReturnOnSameName = false) {
        const selection = this.getCurrentSelection();

        if (!(selection && (selection.length === 1)))
            return;

        if (fileItem === null) {
            fileItem = selection[0];
            allowReturnOnSameName = false;
        }

        if (!fileItem.canRename)
            return;

        if (!this._renameWindow) {
            this.mainApp.activate_action('textEntryAccelsTurnOff', null);

            if (!this.newItemDoRename)
                this.newItemDoRename = new Set();

            this.newItemDoRename.add(fileItem.fileName);

            if (this.desktopMenuManager.popupmenu) {
                await this.desktopMenuManager.menuclosed()
                    .catch(e => logError(e));
            }

            if (this.fileItemMenu.popupmenu)
                await this.fileItemMenu.menuclosed().catch(e => logError(e));

            this._renameWindow = new AskRenamePopup.AskRenamePopup(
                fileItem,
                allowReturnOnSameName,
                () => {
                    const parentWindow = this.getDialogParentWindow();
                    if (parentWindow)
                        parentWindow.grab_focus();
                    this.mainApp.activate_action('textEntryAccelsTurnOn', null);
                    if (this.newItemDoRename)
                        this.newItemDoRename.delete(fileItem.fileName);
                    this._renameWindow = null;
                },
                this.dropOperations.setPendingFilePosition.bind(
                    this.dropOperations
                ),
                {
                    FileUtils: this.FileUtils,
                    DesktopIconsUtil: this.DesktopIconsUtil,
                    DBusUtils: this.DBusUtils,
                }
            );
        }
    }

    async doNewFolder(
        position = null,
        suggestedName = null,
        opts = {rename: true}
    ) {
        this.unselectAll();

        if (!position)
            position = [this._clickX, this._clickY];


        const baseName = suggestedName ? suggestedName : _('New Folder');
        let newName = this.desktopMonitor.getDesktopUniqueFileName(baseName);

        if (newName) {
            const dir = this.desktopDir.get_child(newName);

            try {
                this.dropOperations.setPendingFilePosition(dir, position);
                await dir.make_directory_async(GLib.PRIORITY_DEFAULT, null);

                const info = new Gio.FileInfo();
                info.set_attribute_uint32(Gio.FILE_ATTRIBUTE_UNIX_MODE, 0o700);

                try {
                    await dir.set_attributes_async(info,
                        Gio.FileQueryInfoFlags.NONE,
                        GLib.PRIORITY_LOW,
                        null);
                } catch (e) {
                    console.error(
                        e, `Failed to set attributes to ${dir.get_path()}`);
                }
            } catch (e) {
                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    this._performSanityChecks();
                else
                    console.error(e, `Failed to create folder ${e.message}`);
                const header = _('Folder Creation Failed');
                const text = _('Could not create folder');
                this.dbusManager.doNotify(header, text);
                if (position || suggestedName)
                    return null;

                return null;
            }

            if (opts.rename) {
                if (!this.newItemDoRename)
                    this.newItemDoRename = new Set();

                this.newItemDoRename.add(newName);
            }

            if (position || suggestedName)
                return dir.get_uri();
        }

        return null;
    }

    async redrawDesktop() {
        // fileList is not changed, we just need to render the desktop again
        // with changes in icon color, emblem, appearance, theme change etc.
        const layoutRequest = {operationFlags: {redisplay: true}};
        const fileList = [...this.desktopMonitor.fileList];

        await this._runSerializedDrawDesktop(fileList, layoutRequest).catch(e => {
            console.error(
                `Error while redrawing desktop: ${e.message}\n${e.stack}`
            );
        });
    }

    async reLoadDesktop() {
        await this.desktopMonitor.reLoadFileList();
    }

    async refreshDesktop() {
        // fileList is changed, we need to render the desktop again
        // with latest fileList from the desktopMonitor. The position of the
        // icons is also recomputed from the normalized coordinates.
        const layoutRequest = {operationFlags: {initialRead: true}};
        const fileList = [...this.desktopMonitor.fileList];

        await this._runSerializedDrawDesktop(fileList, layoutRequest).catch(e => {
            console.error(`Error while refreshing desktop: ${e.message}`);
        });
    }

    async _reFrameDesktop(layoutRequest) {
        // fileList is not changed, grids changed, monitor added, removed,
        // monitor geometry, zoom, or index changed.
        // We need to recompute the position of the icons
        // from the normalized coordinates and redraw the desktop and reassign
        // the icons to the correct grid and monitors
        const fileList = [...this.desktopMonitor.fileList];

        await this._drawDesktop(fileList, layoutRequest);
    }

    onMutterSettingsChanged() {
        this.windowManager.requestGeometryUpdate();
    }

    async onGtkSettingsChanged() {
        // No serializer here. The actual desktop mutation is serialized later
        // when the reload reaches refreshDesktop().
        await this.reLoadDesktop();
        this.desktopMenuManager.updateTemplates();
    }

    async onFreePositionChanged() {
        if (this.Prefs.freePositionIcons || this.Prefs.keepArranged ||
            this.Prefs.keepStacked) {
            await this.reLoadDesktop();
            return;
        }

        // Snap the existing layout as a whole, without transformation or sort.
        await this._runSerializedDrawDesktop(
            [...this.desktopMonitor.fileList],
            {operationFlags: {snapToGrid: true}}
        );
    }

    async onKeepArrangedChanged() {
        if (this.Prefs.keepArranged) {
            await this.runSerializedDesktopMutation(() => {
                this._doSorts({redisplay: true});
                this._rememberArrangedLayout();
            });
        }
    }

    async onUnstackedTypesChanged() {
        if (this.Prefs.keepStacked) {
            await this.runSerializedDesktopMutation(
                this._doStacks.bind(this, {redisplay: true})
            );
        }
    }

    async onkeepStackedChanged() {
        await this.runSerializedDesktopMutation(
            this._applyKeepStackedChange.bind(this)
        );
    }

    async onSortOrderChanged() {
        await this.runSerializedDesktopMutation(
            this._applySortOrderChange.bind(this)
        );
    }

    async onIconSizeChanged() {
        await this.runSerializedDesktopMutation(
            this._applyIconSizeChange.bind(this)
        );

        // Rebuild items with the new icon size outside the desktop serializer.
        const fileList = await this.desktopMonitor.getFileList();

        // A concurrent directory read owns the refresh if this one was cancelled.
        if (fileList === null)
            return;

        await this._runSerializedDrawDesktop(fileList, {
            operationFlags: {initialRead: true, iconSizeChanged: true},
        });
    }

    _applyIconSizeChange() {
        this._displayList.forEach(x => x.removeFromGrid());
        for (let desktop of this._desktops)
            desktop.resizeGrid();
    }

    _applySortOrderChange() {
        if (this.Prefs.keepStacked)
            this._doStacks({redisplay: true});
        else
            this._doSorts({redisplay: true});

        this._rememberArrangedLayout();
    }

    _applyKeepStackedChange() {
        if (this.Prefs.keepStacked)
            this._doStacks({redisplay: true});
        else
            this._unstack();
    }

    onDarkModeChanged() {
        this.widgetManager.onThemeChanged();
    }

    onAnimationChanged() {
        this.widgetManager.onAnimationChanged();
    }

    // Getters and Setters

    get desktopDir() {
        return this.desktopMonitor.desktopDir;
    }

    get fractionalScaling() {
        return this.Prefs.fractionalScaling;
    }

    set fractionalScaling(boolean) {
        this.Prefs.fractionalScaling = boolean;
    }

    get _desktops() {
        return this.windowManager.desktops;
    }

    get _primaryMonitorIndex() {
        return this.windowManager.primaryMonitorIndex;
    }

    get _priorPrimaryMonitorIndex() {
        return this.windowManager.priorPrimaryMonitorIndex;
    }

    get preferredDisplayDesktop() {
        return this.windowManager.preferredDisplayDesktop;
    }

    get templatesMonitor() {
        return this.desktopActions.templatesMonitor;
    }

    get currentWorkingList() {
        let currentCompleteList;
        if (this._compositeStackList && (this._compositeStackList.length > 0))
            currentCompleteList = this._compositeStackList;
        else
            currentCompleteList = this._displayList;

        return currentCompleteList;
    }

    get activeFileItem() {
        return this.fileItemMenu.activeFileItem;
    }

    set activeFileItem(fileItem) {
        this.fileItemMenu.activeFileItem = fileItem;
    }

    get positionsForNewFiles() {
        return this.dropOperations.positionsForNewFiles;
    }

    get positionsForExistingFiles() {
        return this.dropOperations.positionsForExistingFiles;
    }

    get writableByOthers() {
        return this.desktopMonitor._writableByOthers;
    }

    get modifierMode() {
        return {
            state: this._lastModifierState,
            ctrl: (this._lastModifierState & Gdk.ModifierType.CONTROL_MASK) !== 0,
            shift: (this._lastModifierState & Gdk.ModifierType.SHIFT_MASK) !== 0,
            alt: (this._lastModifierState & Gdk.ModifierType.ALT_MASK) !== 0,
        };
    }
};
