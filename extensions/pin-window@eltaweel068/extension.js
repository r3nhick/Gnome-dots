import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

const PIN_ICON = 'view-pin-symbolic';
const OPACITY_MIN = 50;
const OPACITY_MAX = 255;
const toFraction = v => (v - OPACITY_MIN) / (OPACITY_MAX - OPACITY_MIN);
const fromFraction = f => Math.round(OPACITY_MIN + f * (OPACITY_MAX - OPACITY_MIN));

function formatAccel(accel) {
    if (!accel) return 'Disabled';
    // Convert e.g. '<Super><Shift>p' -> 'Super+Shift+P'
    const parts = [];
    const re = /<([^>]+)>/g;
    let m;
    let rest = accel;
    while ((m = re.exec(accel)) !== null) {
        let mod = m[1];
        if (mod === 'Primary') mod = 'Ctrl';
        parts.push(mod);
    }
    rest = accel.replace(/<[^>]+>/g, '');
    if (rest.length === 1) rest = rest.toUpperCase();
    if (rest) parts.push(rest);
    return parts.join('+');
}

const POSITIONS = [
    { id: 'top-left',     label: 'Top Left' },
    { id: 'top-center',   label: 'Top Center' },
    { id: 'top-right',    label: 'Top Right' },
    { id: 'left',         label: 'Left' },
    { id: 'center',       label: 'Center' },
    { id: 'right',        label: 'Right' },
    { id: 'bottom-left',  label: 'Bottom Left' },
    { id: 'bottom-center',label: 'Bottom Center' },
    { id: 'bottom-right', label: 'Bottom Right' },
];

function placeWindow(win, posId) {
    const monitor = win.get_monitor();
    const work = Main.layoutManager.getWorkAreaForMonitor(monitor);
    const r = win.get_frame_rect();
    const margin = 12;

    let x = work.x + margin;
    let y = work.y + margin;

    if (posId.includes('right'))
        x = work.x + work.width - r.width - margin;
    else if (posId.includes('center'))
        x = work.x + Math.floor((work.width - r.width) / 2);
    else if (posId === 'left' || posId === 'center')
        x = work.x + margin;

    if (posId.startsWith('top-'))
        y = work.y + margin;
    else if (posId.startsWith('bottom-'))
        y = work.y + work.height - r.height - margin;
    else
        y = work.y + Math.floor((work.height - r.height) / 2);

    if (posId === 'left')  { x = work.x + margin; y = work.y + Math.floor((work.height - r.height) / 2); }
    if (posId === 'right') { x = work.x + work.width - r.width - margin; y = work.y + Math.floor((work.height - r.height) / 2); }
    if (posId === 'center'){ x = work.x + Math.floor((work.width - r.width) / 2); y = work.y + Math.floor((work.height - r.height) / 2); }

    win.move_frame(true, x, y);
}

const PinIndicator = GObject.registerClass(
class PinIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Pin Window');
        this._ext = ext;

        this._icon = new St.Icon({
            icon_name: PIN_ICON,
            style_class: 'system-status-icon pin-window-icon',
        });
        this.add_child(this._icon);

        this._toggleItem = new PopupMenu.PopupMenuItem('Pin focused window');
        this._toggleItem.connect('activate', () => ext.togglePinFocused());
        this.menu.addMenuItem(this._toggleItem);

        this._unpinAllItem = new PopupMenu.PopupMenuItem('Unpin all windows');
        this._unpinAllItem.connect('activate', () => ext.unpinAll());
        this.menu.addMenuItem(this._unpinAllItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const opacityItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        const opacityLabel = new St.Label({
            text: 'Default opacity',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const initial = ext._settings.get_int('pin-opacity');
        this._opacitySlider = new Slider.Slider(toFraction(initial));
        this._opacityValue = new St.Label({
            text: `${Math.round((initial / 255) * 100)}%`,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'min-width: 3em; text-align: right;',
        });
        this._opacitySlider.connect('notify::value', () => {
            const v = fromFraction(this._opacitySlider.value);
            ext._settings.set_int('pin-opacity', v);
            this._opacityValue.text = `${Math.round((v / 255) * 100)}%`;
        });
        opacityItem.add_child(opacityLabel);
        opacityItem.add_child(this._opacitySlider);
        opacityItem.add_child(this._opacityValue);
        this._opacitySlider.x_expand = true;
        this.menu.addMenuItem(opacityItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._pinnedSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._pinnedSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._hint = new PopupMenu.PopupMenuItem('', { reactive: false });
        this.menu.addMenuItem(this._hint);
        this._updateShortcutHint();

        this._shortcutId = ext._settings.connect('changed::toggle-pin',
            () => this._updateShortcutHint());

        this._focusId = global.display.connect('notify::focus-window', () => this._sync());

        this._menuOpenId = this.menu.connect('open-state-changed', (_m, open) => {
            if (open) this._rebuildPinnedSection();
        });

        this._sync();
    }

    _rebuildPinnedSection() {
        this._pinnedSection.removeAll();

        const pinned = this._ext._pinned ? [...this._ext._pinned] : [];
        if (pinned.length === 0) {
            const empty = new PopupMenu.PopupMenuItem('No pinned windows', { reactive: false });
            this._pinnedSection.addMenuItem(empty);
            return;
        }

        for (const win of pinned) {
            if (!win || typeof win.get_title !== 'function') continue;
            let title = win.get_title() || win.get_wm_class() || 'Window';
            if (title.length > 40) title = title.slice(0, 38) + '…';

            const sub = new PopupMenu.PopupSubMenuMenuItem(title);

            for (const pos of POSITIONS) {
                const item = new PopupMenu.PopupMenuItem(pos.label);
                item.connect('activate', () => {
                    try { placeWindow(win, pos.id); } catch (_) {}
                });
                sub.menu.addMenuItem(item);
            }

            sub.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const winOpacity = this._ext._getOpacity(win);
            const opItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
            const opLabel = new St.Label({
                text: 'Opacity',
                y_align: Clutter.ActorAlign.CENTER,
            });
            const opSlider = new Slider.Slider(toFraction(winOpacity));
            const opValue = new St.Label({
                text: `${Math.round((winOpacity / 255) * 100)}%`,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'min-width: 3em; text-align: right;',
            });
            opSlider.x_expand = true;
            opSlider.connect('notify::value', () => {
                const v = fromFraction(opSlider.value);
                this._ext._setOpacity(win, v);
                opValue.text = `${Math.round((v / 255) * 100)}%`;
            });
            opItem.add_child(opLabel);
            opItem.add_child(opSlider);
            opItem.add_child(opValue);
            sub.menu.addMenuItem(opItem);

            const hidden = this._ext._isHidden(win);
            const hideItem = new PopupMenu.PopupMenuItem(hidden ? 'Show' : 'Hide');
            hideItem.connect('activate', () => this._ext.toggleHide(win));
            sub.menu.addMenuItem(hideItem);

            const unpinItem = new PopupMenu.PopupMenuItem('Unpin');
            unpinItem.connect('activate', () => {
                this._ext._unpin(win);
                this._sync();
            });
            sub.menu.addMenuItem(unpinItem);

            this._pinnedSection.addMenuItem(sub);
        }
    }

    _updateShortcutHint() {
        const accels = this._ext._settings.get_strv('toggle-pin');
        const label = accels.length ? formatAccel(accels[0]) : 'Disabled';
        this._hint.label.text = `Shortcut: ${label}`;
    }

    _sync() {
        const win = global.display.focus_window;
        const focusedPinned = win && this._ext._pinned && this._ext._pinned.has(win);
        this._toggleItem.label.text = focusedPinned ? 'Unpin focused window' : 'Pin focused window';

        const anyPinned = this._ext._pinned && this._ext._pinned.size > 0;
        if (anyPinned)
            this._icon.add_style_class_name('pin-window-active');
        else
            this._icon.remove_style_class_name('pin-window-active');
    }

    destroy() {
        if (this._focusId)
            global.display.disconnect(this._focusId);
        if (this._menuOpenId)
            this.menu.disconnect(this._menuOpenId);
        if (this._shortcutId)
            this._ext._settings.disconnect(this._shortcutId);
        super.destroy();
    }
});

export default class PinWindowExtension extends Extension {
    enable() {
        this._pinned = new Set();
        this._hidden = new Set();
        this._opacities = new Map();
        this._borders = new Map();
        this._borderSignalIds = new Map();
        this._overviewShownId = 0;
        this._overviewHiddenId = 0;
        this._windowCreatedId = 0;
        this._focusWindowId = 0;
        this._restackedId = 0;
        this._wsSwitchId = 0;
        this._settings = this.getSettings();

        this._addIndicator();

        this._panelBoxId = this._settings.connect('changed::panel-box',
            () => this._addIndicator());
        this._panelIndexId = this._settings.connect('changed::panel-index',
            () => this._addIndicator());
        this._showIconId = this._settings.connect('changed::show-panel-icon',
            () => this._addIndicator());
        this._showBorderId = this._settings.connect('changed::show-pinned-border',
            () => this._syncPinnedBorders());
        this._borderWidthId = this._settings.connect('changed::border-width',
            () => this._updateBorderColors());
        this._overviewShownId = Main.overview.connect('showing', () => this._syncAllBorders());
        this._overviewHiddenId = Main.overview.connect('hidden', () => this._syncAllBorders());
        this._opacityId = this._settings.connect('changed::pin-opacity', () => {
            // Default-only; existing per-window opacities are preserved.
        });

        this._windowCreatedId = global.display.connect('window-created', (_display, win) => {
            this._logWindowInfo(win, 'created');
            // Identifiers (wm_class/title) are not yet known at creation time,
            // so re-check once they are populated.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                this._watchVicinaeActor(win);
                this._maybeRaiseVicinae(win);
                this._logWindowInfo(win, 'settled');
                return GLib.SOURCE_REMOVE;
            });
        });
        this._restackedId = global.display.connect('restacked', () => {
            this._syncVicinaeStacking();
            this._syncAllBorders();
        });
        this._wsSwitchId = global.workspace_manager.connect('workspace-switched',
            (_wm, from, to) => this._onWorkspaceSwitched(from, to));
        this._focusWindowId = global.display.connect('notify::focus-window', () => {
            this._syncVicinaeStacking();
        });

        try {
            this._accentSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
            this._accentColorId = this._accentSettings.connect('changed::accent-color',
                () => this._updateBorderColors());
        } catch (e) {
            this._accentSettings = null;
            this._accentColorId = 0;
        }

        Main.wm.addKeybinding(
            'toggle-pin',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this.togglePinFocused()
        );
    }

    disable() {
        Main.wm.removeKeybinding('toggle-pin');

        if (this._settings) {
            if (this._panelBoxId) this._settings.disconnect(this._panelBoxId);
            if (this._panelIndexId) this._settings.disconnect(this._panelIndexId);
            if (this._showIconId) this._settings.disconnect(this._showIconId);
            if (this._showBorderId) this._settings.disconnect(this._showBorderId);
            if (this._borderWidthId) this._settings.disconnect(this._borderWidthId);
            if (this._opacityId) this._settings.disconnect(this._opacityId);
            this._panelBoxId = 0;
            this._panelIndexId = 0;
            this._showIconId = 0;
            this._showBorderId = 0;
            this._borderWidthId = 0;
            this._opacityId = 0;
        }

        if (this._windowCreatedId) {
            try { global.display.disconnect(this._windowCreatedId); } catch (e) {}
        }
        this._windowCreatedId = 0;

        if (this._focusWindowId) {
            try { global.display.disconnect(this._focusWindowId); } catch (e) {}
        }
        this._focusWindowId = 0;

        if (this._restackedId) {
            try { global.display.disconnect(this._restackedId); } catch (e) {}
        }
        this._restackedId = 0;

        if (this._wsSwitchId) {
            try { global.workspace_manager.disconnect(this._wsSwitchId); } catch (e) {}
        }
        this._wsSwitchId = 0;

        if (this._overviewShownId) {
            try { Main.overview.disconnect(this._overviewShownId); } catch (e) {}
        }
        if (this._overviewHiddenId) {
            try { Main.overview.disconnect(this._overviewHiddenId); } catch (e) {}
        }
        this._overviewShownId = 0;
        this._overviewHiddenId = 0;

        if (this._accentSettings && this._accentColorId) {
            try { this._accentSettings.disconnect(this._accentColorId); } catch (_) {}
        }
        this._accentSettings = null;
        this._accentColorId = 0;

        this.unpinAll();

        if (this._unmanagedIds) {
            for (const [win, id] of this._unmanagedIds) {
                try { win.disconnect(id); } catch (_) {}
            }
            this._unmanagedIds.clear();
            this._unmanagedIds = null;
        }

        this._indicator?.destroy();
        this._indicator = null;
        this._pinned = null;
        this._hidden = null;
        this._opacities = null;
        this._borders = null;
        this._borderSignalIds = null;
        this._settings = null;
    }

    _addIndicator() {
        this._indicator?.destroy();
        this._indicator = null;
        if (!this._settings || !this._settings.get_boolean('show-panel-icon'))
            return;
        this._indicator = new PinIndicator(this);
        const box = this._settings.get_string('panel-box');
        const index = this._settings.get_int('panel-index');
        Main.panel.addToStatusArea('pin-window', this._indicator, index, box);
    }

    togglePinFocused() {
        const win = global.display.focus_window;
        if (!win) return;

        if (this._pinned && this._pinned.has(win)) {
            this._unpin(win);
        } else {
            this._pin(win);
        }
        this._indicator?._sync();
    }

    _pin(win) {
        try {
            if (win.is_on_all_workspaces()) win.unstick();
        } catch (e) {
            log(`pin-window: unstick() failed: ${e}`);
        }
        if (typeof win.is_above === 'function' ? !win.is_above() : true) {
            try { win.make_above(); } catch (_) {}
        }
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._syncVicinaeStacking();
            return GLib.SOURCE_REMOVE;
        });
        this._pinned.add(win);
        if (!this._opacities.has(win))
            this._opacities.set(win, this._settings.get_int('pin-opacity'));
        this._applyOpacity(win, this._opacities.get(win));

        if (!this._unmanagedIds) this._unmanagedIds = new Map();
        if (!this._unmanagedIds.has(win)) {
            const id = win.connect('unmanaged', () => {
                this._pinned?.delete(win);
                this._hidden?.delete(win);
                this._opacities?.delete(win);
                this._removeBorder(win);
                this._unmanagedIds?.delete(win);
                this._indicator?._sync();
            });
            this._unmanagedIds.set(win, id);
        }

        this._addBorder(win);
        this._playPinSound();
        this._indicator?._sync();

        try {
            log(`pin-window: pinned '${win.get_title()}' ws=${win.get_workspace()?.index() ?? '?'} onAll=${win.is_on_all_workspaces()} above=${win.is_above()}`);
        } catch (e) {}
    }

    _unpin(win) {
        try {
            if (this._isHidden(win)) {
                win.unminimize();
                this._hidden.delete(win);
            }
            win.unstick();
            win.unmake_above();
        } catch (_) {}
        const unmanagedId = this._unmanagedIds?.get(win);
        if (unmanagedId) {
            try { win.disconnect(unmanagedId); } catch (_) {}
            this._unmanagedIds.delete(win);
        }
        this._removeBorder(win);
        this._applyOpacity(win, 255);
        this._pinned.delete(win);
        this._opacities?.delete(win);
        this._indicator?._sync();
    }

    _getOpacity(win) {
        if (this._opacities?.has(win)) return this._opacities.get(win);
        return this._settings.get_int('pin-opacity');
    }

    _setOpacity(win, value) {
        this._opacities?.set(win, value);
        this._applyOpacity(win, value);
    }

    _applyOpacity(win, value) {
        try {
            const actor = typeof win.get_compositor_private === 'function'
                ? win.get_compositor_private() : null;
            if (actor) actor.opacity = value;
        } catch (_) {}
    }

    _isHidden(win) {
        return this._hidden && this._hidden.has(win);
    }

    toggleHide(win) {
        try {
            if (this._isHidden(win)) {
                win.unminimize();
                win.activate(global.get_current_time());
                this._hidden.delete(win);
            } else {
                win.minimize();
                this._hidden.add(win);
            }
            this._syncBorderVisibility(win);
        } catch (_) {}
    }

    unpinAll() {
        if (!this._pinned) return;
        for (const win of [...this._pinned])
            this._unpin(win);
        this._hidden?.clear();
        this._opacities?.clear();
        for (const win of [...this._borders.keys()])
            this._removeBorder(win);
        this._indicator?._sync();
    }

    _borderWidth() {
        try { return this._settings ? this._settings.get_int('border-width') : 2; }
        catch (e) { return 2; }
    }

    _playPinSound() {
        try {
            if (!this._settings || !this._settings.get_boolean('play-sound')) return;
            GLib.spawn_async(null, ['canberra-gtk-play', '-i', 'message'], null,
                GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                null);
        } catch (e) {}
    }

    _isVicinae(win) {
        try {
            const s = [
                typeof win.get_wm_class === 'function' ? (win.get_wm_class() || '') : '',
                typeof win.get_wm_class_instance === 'function' ? (win.get_wm_class_instance() || '') : '',
                typeof win.get_gtk_application_id === 'function' ? (win.get_gtk_application_id() || '') : '',
                typeof win.get_title === 'function' ? (win.get_title() || '') : '',
            ].join(' ').toLowerCase();
            return s.includes('vicinae');
        } catch (e) {
            return false;
        }
    }

    _logWindowInfo(win, ev) {
        try {
            const cls = typeof win.get_wm_class === 'function' ? (win.get_wm_class() || '?') : '?';
            const inst = typeof win.get_wm_class_instance === 'function' ? (win.get_wm_class_instance() || '?') : '?';
            const app = typeof win.get_gtk_application_id === 'function' ? (win.get_gtk_application_id() || '?') : '?';
            const title = typeof win.get_title === 'function' ? (win.get_title() || '?') : '?';
            log(`pin-window: window ${ev}: class='${cls}' instance='${inst}' app='${app}' title='${title}'`);
        } catch (e) {}
    }

    _watchVicinaeActor(win) {
        try {
            if (!this._isVicinae(win)) return;
            const actor = (typeof win.get_compositor_private === 'function')
                ? win.get_compositor_private() : null;
            if (!actor || actor._pinVicinaeWatched) return;
            actor._pinVicinaeWatched = true;
            actor.connect('notify::mapped', () => {
                if (actor.mapped) this._showVicinae();
            });
            actor.connect('notify::visible', () => {
                if (actor.visible) this._showVicinae();
            });
        } catch (e) {}
    }

    _maybeRaiseVicinae(win) {
        try {
            if (!this._isVicinae(win)) return;
            this._showVicinae();
        } catch (e) {}
    }

    _showVicinae() {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                const actors = global.get_window_actors();
                for (const a of actors) {
                    const w = a.meta_window;
                    if (!w || !this._isVicinae(w)) continue;
                    if (!w.showing_on_its_workspace()) continue;
                    try { w.make_above(); } catch (e) {}
                    try { w.raise(); } catch (e) {}
                    try { w.activate(global.get_current_time()); } catch (e) {}
                }
            } catch (e) {}
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncVicinaeStacking() {
        try {
            const actors = global.get_window_actors();
            for (const a of actors) {
                const w = a.meta_window;
                if (!w || !this._isVicinae(w)) continue;
                try { w.make_above(); } catch (e) {}
                try { w.raise(); } catch (e) {}
            }
        } catch (e) {}
    }

    _accentHex() {
        const map = {
            blue: '#3584e4', teal: '#2190a4', green: '#3a944a',
            yellow: '#c88800', orange: '#ed5b00', red: '#e62d42',
            pink: '#d56199', purple: '#9141ac', slate: '#6f8396',
        };
        try {
            const name = this._accentSettings ? this._accentSettings.get_string('accent-color') : 'blue';
            return map[name] || map.blue;
        } catch (e) {
            return map.blue;
        }
    }

    _addBorder(win) {
        if (!this._borders || !this._settings || !this._settings.get_boolean('show-pinned-border'))
            return;
        if (this._borders.has(win)) return;
        const actor = new St.Widget({ reactive: false });
        actor.style = `border: ${this._borderWidth()}px solid ${this._accentHex()}; border-radius: 10px;`;
        try { Main.uiGroup.add_child(actor); } catch (e) { return; }
        this._borders.set(win, actor);
        this._borderSignalIds.set(win, []);
        const update = () => this._updateBorder(win);
        const ids = [];
        try { ids.push(win.connect('position-changed', update)); } catch (e) {}
        try { ids.push(win.connect('size-changed', update)); } catch (e) {}
        try { ids.push(win.connect('workspace-changed', update)); } catch (e) {}
        this._borderSignalIds.set(win, ids);
        update();
    }

    _updateBorder(win) {
        const actor = this._borders?.get(win);
        if (!actor) return;
        try {
            const rect = win.get_frame_rect();
            actor.set_position(rect.x, rect.y);
            actor.set_size(rect.width, rect.height);
        } catch (e) {}
        this._syncBorderVisibility(win);
    }

    _syncBorderVisibility(win) {
        const actor = this._borders?.get(win);
        if (!actor) return;
        try {
            const show = this._settings.get_boolean('show-pinned-border') && !this._hidden.has(win);
            const showing = (typeof win.showing_on_its_workspace === 'function')
                ? win.showing_on_its_workspace() : true;
            const overviewVisible = !!(Main.overview && Main.overview.visible);
            // Border belongs to the window's workspace, not to the user.
            const wws = win.get_workspace ? win.get_workspace() : null;
            const active = global.workspace_manager.get_active_workspace();
            const wsOk = !wws || !active || wws === active;
            actor.visible = show && showing && !overviewVisible && wsOk;
        } catch (e) {
            actor.visible = false;
        }
    }

    _onWorkspaceSwitched(from, to) {
        this._syncAllBorders();
    }

    _syncAllBorders() {
        if (!this._borders) return;
        for (const win of this._borders.keys())
            this._syncBorderVisibility(win);
    }

    _removeBorder(win) {
        const actor = this._borders?.get(win);
        if (actor) {
            try { actor.destroy(); } catch (e) {}
        }
        this._borders?.delete(win);
        const ids = this._borderSignalIds?.get(win);
        if (ids) {
            for (const id of ids) {
                try { win.disconnect(id); } catch (e) {}
            }
        }
        this._borderSignalIds?.delete(win);
    }

    _updateBorderColors() {
        const color = this._accentHex();
        for (const [win, actor] of this._borders) {
            try { actor.style = `border: ${this._borderWidth()}px solid ${color}; border-radius: 10px;`; } catch (e) {}
        }
    }

    _syncPinnedBorders() {
        if (!this._settings || !this._pinned) return;
        if (this._settings.get_boolean('show-pinned-border')) {
            for (const win of this._pinned) this._addBorder(win);
        } else {
            for (const win of [...this._borders.keys()]) this._removeBorder(win);
        }
        for (const win of this._pinned) this._syncBorderVisibility(win);
    }
}
