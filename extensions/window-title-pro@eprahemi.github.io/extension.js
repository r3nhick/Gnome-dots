//    Window Title Pro Topbar
//    GNOME Shell extension
//
//    panel position, keyboard shortcuts
//    workspace indicator, window count, per-app colors


import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as ParentalControlsManager from 'resource:///org/gnome/shell/misc/parentalControlsManager.js';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

export class AppMenu extends PopupMenu.PopupMenu {
    /**
     * @param {Clutter.Actor} sourceActor - actor the menu is attached to
     * @param {St.Side} side - arrow side
     * @param {object} params - options
     * @param {bool} params.favoritesSection - show items to add/remove favorite
     * @param {bool} params.showSingleWindow - show window section for a single window
     */
    constructor(sourceActor, side = St.Side.TOP, params = {}) {
        if (Clutter.get_default_text_direction() === Clutter.TextDirection.RTL) {
            if (side === St.Side.LEFT)
                side = St.Side.RIGHT;
            else if (side === St.Side.RIGHT)
                side = St.Side.LEFT;
        }

        super(sourceActor, 0.5, side);

        this.actor.add_style_class_name('app-menu');

        const {
            favoritesSection = false,
            showSingleWindows = false,
        } = params;

        this._app = null;
        this._appSystem = Shell.AppSystem.get_default();
        this._parentalControlsManager = ParentalControlsManager.getDefault();
        this._appFavorites = AppFavorites.getAppFavorites();
        this._enableFavorites = favoritesSection;
        this._showSingleWindows = showSingleWindows;

        this._windowsChangedId = 0;
        this._updateWindowsLaterId = 0;

        /* Translators: This is the heading of a list of open windows */
        this._openWindowsHeader = new PopupMenu.PopupSeparatorMenuItem(_('Open Windows'));
        this.addMenuItem(this._openWindowsHeader);

        this._windowSection = new PopupMenu.PopupMenuSection();
        this.addMenuItem(this._windowSection);

        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._newWindowItem = this.addAction(_('New Window'), () => {
            this._animateLaunch();
            this._app.open_new_window(-1);
            Main.overview.hide();
        }, 'window-new-symbolic');

        this._actionSection = new PopupMenu.PopupMenuSection();
        this.addMenuItem(this._actionSection);

        this._onGpuMenuItem = this.addAction('', () => {
            this._animateLaunch();
            this._app.launch(0, -1, this._getNonDefaultLaunchGpu());
            Main.overview.hide();
        });

        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._toggleFavoriteItem = this.addAction('', () => {
            const appId = this._app.get_id();
            if (this._appFavorites.isFavorite(appId))
                this._appFavorites.removeFavorite(appId);
            else
                this._appFavorites.addFavorite(appId);
        });

        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._detailsItem = this.addAction(_('App Details'), async () => {
            const id = this._app.get_id();
            const args = GLib.Variant.new('(ss)', [id, '']);
            const bus = await Gio.DBus.get(Gio.BusType.SESSION, null);
            bus.call(
                'org.gnome.Software',
                '/org/gnome/Software',
                'org.gtk.Actions', 'Activate',
                new GLib.Variant('(sava{sv})', ['details', [args], null]),
                null, 0, -1, null);
            Main.overview.hide();
        }, 'dialog-information-symbolic');

        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._quitItem =
            this.addAction(_('Quit'), () => this._app.request_quit(), 'application-exit-symbolic');

        this._appSystem.connectObject(
            'installed-changed', () => this._updateDetailsVisibility(),
            'app-state-changed', this._onAppStateChanged.bind(this),
            this.actor);

        this._parentalControlsManager.connectObject(
            'app-filter-changed', () => this._updateFavoriteItem(), this.actor);

        this._appFavorites.connectObject(
            'changed', () => this._updateFavoriteItem(), this.actor);

        global.settings.connectObject(
            'writable-changed::favorite-apps', () => this._updateFavoriteItem(),
            this.actor);

        global.connectObject(
            'notify::switcheroo-control', () => this._updateGpuItem(),
            this.actor);

        this._updateQuitItem();
        this._updateFavoriteItem();
        this._updateGpuItem();
        this._updateDetailsVisibility();
    }

    _onAppStateChanged(sys, app) {
        if (this._app !== app)
            return;

        this._updateQuitItem();
        this._updateNewWindowItem();
        this._updateGpuItem();
    }

    _updateQuitItem() {
        this._quitItem.visible = this._app?.state === Shell.AppState.RUNNING;
    }

    _updateNewWindowItem() {
        const actions = this._app?.appInfo?.list_actions() ?? [];
        this._newWindowItem.visible =
            this._app?.can_open_new_window() && !actions.includes('new-window');
    }

    _updateFavoriteItem() {
        const appInfo = this._app?.app_info;
        const canFavorite = appInfo &&
            this._enableFavorites &&
            global.settings.is_writable('favorite-apps') &&
            this._parentalControlsManager.shouldShowApp(appInfo);

        this._toggleFavoriteItem.visible = canFavorite;

        if (!canFavorite)
            return;

        const {id} = this._app;
        this._toggleFavoriteItem.label.text = this._appFavorites.isFavorite(id)
            ? _('Unpin')
            : _('Pin to Dash');
    }

    _updateGpuItem() {
        const proxy = global.get_switcheroo_control();
        const hasDualGpu = proxy?.get_cached_property('HasDualGpu')?.unpack();

        const showItem =
            this._app?.state === Shell.AppState.STOPPED && hasDualGpu;

        this._onGpuMenuItem.visible = showItem;

        if (!showItem)
            return;

        const launchGpu = this._getNonDefaultLaunchGpu();
        this._onGpuMenuItem.label.text = launchGpu === Shell.AppLaunchGpu.DEFAULT
            ? _('Launch Using Integrated Graphics Card')
            : _('Launch Using Discrete Graphics Card');
    }

    _updateDetailsVisibility() {
        const sw = this._appSystem.lookup_app('org.gnome.Software.desktop');
        this._detailsItem.visible = sw !== null;
    }

    _animateLaunch() {
        if (this.sourceActor.animateLaunch)
            this.sourceActor.animateLaunch();
    }

    _getNonDefaultLaunchGpu() {
        return this._app.appInfo.get_boolean('PrefersNonDefaultGPU')
            ? Shell.AppLaunchGpu.DEFAULT
            : Shell.AppLaunchGpu.DISCRETE;
    }

    /** */
    destroy() {
        this.setApp(null);
        super.destroy();
    }

    /**
     * @returns {bool} - true if the menu is empty
     */
    isEmpty() {
        if (!this._app)
            return true;
        return super.isEmpty();
    }

    /**
     * @param {Shell.App} app - the app the menu represents
     */
    setApp(app) {
        if (this._app === app)
            return;

        this._app?.disconnectObject(this);

        this._app = app;

        this._app?.connectObject('windows-changed',
            () => this._queueUpdateWindowsSection(), this);

        this._updateWindowsSection();

        const appInfo = app?.app_info;
        const actions = appInfo?.list_actions() ?? [];

        this._actionSection.removeAll();
        actions.forEach(action => {
            const label = appInfo.get_action_name(action);
            this._actionSection.addAction(label, event => {
                if (action === 'new-window')
                    this._animateLaunch();

                this._app.launch_action(action, event.get_time(), -1);
                Main.overview.hide();
            });
        });

        this._updateQuitItem();
        this._updateNewWindowItem();
        this._updateFavoriteItem();
        this._updateGpuItem();
    }

    _queueUpdateWindowsSection() {
        if (this._updateWindowsLaterId)
            return;

        const laters = global.compositor.get_laters();
        this._updateWindowsLaterId = laters.add(
            Meta.LaterType.BEFORE_REDRAW, () => {
                this._updateWindowsSection();
                return GLib.SOURCE_REMOVE;
            });
    }

    _updateWindowsSection() {
        if (this._updateWindowsLaterId) {
            const laters = global.compositor.get_laters();
            laters.remove(this._updateWindowsLaterId);
        }
        this._updateWindowsLaterId = 0;

        this._windowSection.removeAll();
        this._openWindowsHeader.hide();

        if (!this._app)
            return;

        const minWindows = this._showSingleWindows ? 1 : 2;
        const windows = this._app.get_windows().filter(w => !w.skip_taskbar);
        if (windows.length < minWindows)
            return;

        this._openWindowsHeader.show();

        windows.forEach(window => {
            const title = window.title || this._app.get_name();
            const item = this._windowSection.addAction(title, event => {
                Main.activateWindow(window, event.get_time());
            }, 'window-symbolic');
            window.connectObject('notify::title', () => {
                item.label.text = window.title || this._app.get_name();
            }, item);
        });
    }
}

// ── Reduced motion (GNOME 51+) ──
// GNOME 51 added a system-wide reduced-motion setting (GTK 4.22 parity):
//     const {reducedMotion} = St.Settings.get();
// St.Settings and St.ReducedMotion do not exist on GNOME 45-50, so the
// lookup is guarded and every older shell keeps animating exactly as before.
function _motion_allowed() {
    if (!St.Settings || !St.ReducedMotion)
        return true;
    try {
        return St.Settings.get().reducedMotion !== St.ReducedMotion.REDUCE;
    } catch (e) {
        return true;
    }
}


// ── Per-app color map (app name → hex color, ~350 apps) ──
const APP_COLORS = {
    // ── Browsers (29) ──
    'Firefox':            '#FF7139',
    'Google Chrome':      '#4285F4',
    'Chromium':           '#4285F4',
    'Microsoft Edge':     '#0078D4',
    'Brave':              '#FB542B',
    'Opera':              '#FF1B2D',
    'Vivaldi':            '#EF3939',
    'Tor Browser':        '#7D4F9F',
    'Epiphany':           '#3584E4',
    'Midori':             '#2D9F2D',
    'Falkon':             '#3DAEE9',
    'qutebrowser':        '#E01B24',
    'Pale Moon':          '#3DAEE9',
    'Basilisk':           '#3DAEE9',
    'SeaMonkey':          '#0086D6',
    'LibreWolf':          '#FF7139',
    'Mullvad Browser':    '#25574B',
    'Waterfox':           '#0086D6',
    'Yandex Browser':     '#FF0000',
    'SRWare Iron':        '#808080',
    'Slimjet':            '#FF6600',
    'Ungoogled Chromium': '#4285F4',
    'GNU IceCat':         '#3584E4',
    'Iceweasel':          '#FF7139',
    'Cyberfox':           '#FF7139',
    'Comodo Dragon':      '#0086D6',
    'Maxthon':            '#0086D6',
    'Sputnik':            '#FF0000',
    'Zen Browser':        '#FF7139',

    // ── Communication (20) ──
    'Discord':            '#5865F2',
    'Telegram':           '#26A5E4',
    'Slack':              '#4A154B',
    'Signal':             '#3A76F0',
    'Zoom':               '#2D8CFF',
    'Microsoft Teams':    '#6264A7',
    'Element':            '#0DBD8B',
    'Mattermost':         '#0072C6',
    'Jitsi Meet':         '#0080FF',
    'Pidgin':             '#8CC63F',
    'Empathy':            '#2E3436',
    'Thunderbird':        '#0A84FF',
    'Skype':              '#00AFF0',
    'Viber':              '#7360F2',
    'WhatsApp':           '#25D366',
    'Whatsapp':           '#25D366',
    'ZapZap':             '#25D366',
    'Wire':               '#000000',
    'LINE':               '#00B900',
    'WeChat':             '#07C160',

    // ── Media Players (18) ──
    'Celluloid':          '#E01B24',
    'VLC':                '#FF6600',
    'VLC media player':   '#FF6600',
    'SMPlayer':           '#2196F3',
    'MPV':                '#E01B24',
    'mpv':                '#E01B24',
    'Parole':             '#2196F3',
    'Rhythmbox':          '#F57C00',
    'Lollypop':           '#E91E63',
    'Audacious':          '#FF9800',
    'Clementine':         '#66BB6A',
    'DeaDBeeF':           '#9C27B0',
    'Elisa':              '#3584E4',
    'Spotify':            '#1DB954',
    'RetroPlayer':        '#FF5722',
    'Cosmic Player':      '#E95420',
    'Parlatype':          '#7C4DFF',
    'Showtime':           '#E01B24',

    // ── Video Editing / Transcoding (12) ──
    'Kdenlive':           '#0094F5',
    'Olive':              '#3DAEE9',
    'Shotcut':            '#0086D6',
    'Pitivi':             '#2471A3',
    'Flowblade':          '#333333',
    'DaVinci Resolve':    '#E84C3D',
    'OpenShot':           '#3297E8',
    'HandBrake':          '#FF6600',
    'MKVToolNix':         '#3584E4',
    'OBS Studio':         '#302E31',
    'OBS':                '#302E31',

    // ── Image Editors / Viewers (16) ──
    'GIMP':               '#553D2B',
    'Inkscape':           '#2C2C2C',
    'Krita':              '#3BBAF6',
    'Darktable':          '#414141',
    'RawTherapee':        '#3B7DD8',
    'Shotwell':           '#4A86C8',
    'Loupe':              '#3584E4',
    'Eye of GNOME':       '#3584E4',
    'eog':                '#3584E4',
    'Image Viewer':       '#3584E4',
    'Drawing':            '#E01B24',
    'Pencil':             '#4CAF50',
    'Pinta':              '#3FAAF4',
    'Upscayl':            '#7C3AED',
    'Color Picker':       '#FF9800',
    'Komikku':            '#E91E63',

    // ── 3D / Modeling (5) ──
    'Blender':            '#E87D0D',
    'FreeCAD':            '#F57C00',
    'OpenSCAD':           '#F57C00',
    'MeshLab':            '#3584E4',
    'SolveSpace':         '#3584E4',

    // ── Development (28) ──
    'Visual Studio Code': '#007ACC',
    'Code':               '#007ACC',
    'VSCodium':           '#3FAF4E',
    'Sublime Text':       '#FF9800',
    'Sublime Merge':      '#FF9800',
    'Atom':               '#40A977',
    'Zed':                '#282C34',
    'Nova':               '#FE315D',
    'Kate':               '#1CDC9C',
    'KDevelop':           '#3DAEE9',
    'Anjuta':             '#3584E4',
    'Geany':              '#418F3E',
    'Bluefish':           '#3584E4',
    'Builder':            '#3584E4',
    'GNOME Builder':      '#3584E4',
    'IntelliJ IDEA':      '#FE315D',
    'PyCharm':            '#21D789',
    'WebStorm':           '#07C3F2',
    'Rider':              '#FE315D',
    'GoLand':             '#07C3F2',
    'RustRover':          '#FE315D',
    'CLion':              '#FE315D',
    'DataGrip':           '#07C3F2',
    'PhpStorm':           '#FE315D',
    'Android Studio':     '#3DDC84',
    'Fleet':              '#EE3F24',
    'Eclipse':            '#2C2255',
    'Qt Creator':         '#41CD52',
    'Emacs':              '#7B5EA7',
    'Neovim':             '#57A143',
    'Vim':                '#019833',
    'GitHub Desktop':     '#24292F',
    'Fork':               '#24292F',
    'Cursor':             '#000000',

    // ── Terminals (17) ──
    'Kitty':              '#26A269',
    'kitty':              '#26A269',
    'Alacritty':          '#26A269',
    'Tilix':              '#26A269',
    'Terminator':         '#26A269',
    'Terminology':        '#26A269',
    'Hyper':              '#26A269',
    'WezTerm':            '#26A269',
    'Foot':               '#26A269',
    'Ghostty':            '#26A269',
    'Console':            '#26A269',
    'Console Emulator':   '#26A269',
    'Xfce4 Terminal':     '#26A269',
    'LXTerminal':         '#26A269',
    'Guake':              '#26A269',
    'Yakuake':            '#26A269',
    'Warp':               '#26A269',
    'Tabby':              '#26A269',

    // ── File Managers (14) ──
    'Nautilus':           '#3584E4',
    'Files':              '#3584E4',
    'Nemo':               '#3584E4',
    'Dolphin':            '#3DAEE9',
    'Thunar':             '#3584E4',
    'PCManFM':            '#3584E4',
    'Caja':               '#3584E4',
    'Double Commander':   '#FF9800',
    'Midnight Commander': '#FF9800',
    'Krude':              '#3584E4',
    'Open Folder':        '#3584E4',
    'Penta Commander':    '#FF9800',
    'Sunflower':          '#3584E4',
    'Worker':             '#3584E4',

    // ── Office (14) ──
    'LibreOffice Writer': '#18A303',
    'LibreOffice Calc':   '#18A303',
    'LibreOffice Impress':'#18A303',
    'LibreOffice Draw':   '#18A303',
    'LibreOffice Base':   '#18A303',
    'LibreOffice Math':   '#18A303',
    'LibreOffice':        '#18A303',
    'LibreOffice StartCenter': '#18A303',
    'ONLYOFFICE':         '#E95420',
    'WPS Office':         '#00A98F',
    'Calligra Words':     '#2D8F2D',
    'Calligra Sheets':    '#2D8F2D',
    'AbiWord':            '#3584E4',
    'Gnumeric':           '#3584E4',

    // ── Notes / Knowledge (15) ──
    'Obsidian':           '#7C3AED',
    'Notion':             '#000000',
    'Logseq':             '#5B8F5B',
    'Joplin':             '#1071D6',
    'Simplenote':         '#3361CC',
    'Tomboy':             '#3584E4',
    'Zim':                '#3584E4',
    'Gnote':              '#3584E4',
    'Notes':              '#FFB300',
    'DevDocs':            '#4CAF50',
    'Zeal':               '#3584E4',
    'CherryTree':         '#E01B24',
    'Trilium':            '#3584E4',
    'Bookworm':           '#E91E63',
    'yarp-nix':           '#3584E4',

    // ── Reference / Research (4) ──
    'Zotero':             '#CC2936',
    'Mendeley':           '#A6192E',
    'Calibre':            '#E01B24',
    'Anki':               '#2D5DA1',

    // ── GNOME Apps (28) ──
    'Settings':           '#3584E4',
    'System Monitor':     '#C01C28',
    'Extensions':         '#3584E4',
    'Tweaks':             '#3584E4',
    'Disks':              '#3584E4',
    'Fonts':              '#3584E4',
    'Calendar':           '#3584E4',
    'Contacts':           '#3584E4',
    'Weather':            '#3584E4',
    'Clocks':             '#3584E4',
    'Calculator':         '#3584E4',
    'Document Viewer':    '#3584E4',
    'Maps':               '#3584E4',
    'Characters':         '#3584E4',
    'Logs':               '#3584E4',
    'Connections':        '#3584E4',
    'Snapshot':           '#3584E4',
    'Firmware':           '#3584E4',
    'Help':               '#3584E4',
    'Passwords and Keys': '#3584E4',
    'Disk Usage Analyzer':'#3584E4',
    'Text Editor':        '#3584E4',
    'Mousam':             '#3584E4',
    'Software':           '#3584E4',
    'Flatseal':           '#3584E4',
    'Extension Manager':  '#3584E4',
    'Gear Lever':         '#3584E4',
    'Boxes':              '#2D9F2D',
    'Document Scanner':   '#3584E4',
    'Fedora Media Writer':'#3584E4',
    'Simple Scan':        '#3584E4',

    // ── KDE Apps (9) ──
    'Konsole':            '#26A269',
    'Okular':             '#3DAEE9',
    'Spectacle':          '#3DAEE9',
    'Gwenview':           '#3DAEE9',
    'Ark':                '#3DAEE9',
    'KCalc':              '#3DAEE9',
    'KWrite':             '#1CDC9C',
    'SystemSettings':     '#3DAEE9',
    'Kile':               '#3DAEE9',

    // ── Gaming (24) ──
    'Steam':              '#1B2838',
    'Lutris':             '#FF6600',
    'Heroic Games Launcher':'#F5A623',
    'Heroic':             '#F5A623',
    'MangoHud':           '#FF4444',
    'ProtonUp-Qt':        '#4CAF50',
    'Protontricks':       '#8B6914',
    'Bottles':            '#3584E4',
    'PlayOnLinux':        '#3584E4',
    'Wine':               '#8B6914',
    'DOSBox':             '#8B6914',
    'PCSX2':              '#3584E4',
    'RetroArch':          '#FF4444',
    'Dolphin Emulator':   '#3DAEE9',
    'Citra':              '#E91E63',
    'Yuzu':               '#E91E63',
    'Ryujinx':            '#E91E63',
    'GameHub':            '#FF6600',
    'Prism Launcher':     '#FF6600',
    'PolyMC':             '#FF6600',
    'Minecraft Launcher': '#8B6914',
    'PrismLauncher':      '#FF6600',
    'itch':               '#FA5C5C',
    'Games':              '#3584E4',

    // ── Graphics / Design (14) ──
    'Scribus':            '#C01C28',
    'Xfig':               '#FF9800',
    'Synfig Studio':      '#FF9800',
    'Glaxnimate':         '#FF9800',
    'Blockbench':         '#3584E4',
    'Material Maker':     '#FF9800',
    'Tiled':              '#3584E4',
    'Aseprite':           '#FF6600',
    'Piskel':             '#FF6600',
    'MyPaint':            '#3584E4',
    'Colora':             '#FF9800',
    'gpick':              '#3584E4',
    'Karbon':             '#2D8F2D',
    'Karalize':           '#2D8F2D',

    // ── Science / Math (11) ──
    'GNU Octave':         '#E01B24',
    'Mathematica':        '#DD1100',
    'MATLAB':             '#FF6600',
    'Scilab':             '#0086D6',
    'RStudio':            '#75AADB',
    'Spyder':             '#FF0000',
    'Orange':             '#FF9800',
    'Jupyter Notebook':   '#F37626',
    'JupyterLab':         '#F37626',
    'Xcos':               '#0086D6',
    'LaTeXila':           '#3584E4',

    // ── Network / VPN / System (15) ──
    'Wireshark':          '#1679A7',
    'nmap':               '#3584E4',
    'GNS3':               '#00B9E4',
    'PuTTY':              '#3584E4',
    'FileZilla':          '#BF0000',
    'Transmission':       '#FF6600',
    'qBittorrent':        '#3584E4',
    'Deluge':             '#3584E4',
    'aria2':              '#3584E4',
    'uGet':               '#FF9800',
    'Proton VPN':         '#67A4DB',
    'ProtonVPN':          '#67A4DB',
    'NordVPN':            '#4687FF',
    'OpenVPN':            '#E01B24',
    'WireGuard':          '#88171A',
    'OpenConnect':        '#3584E4',
    'Cloudflare WARP':    '#F48120',

    // ── Virtualization / Containers (6) ──
    'QEMU':               '#FF6600',
    'Virt-Manager':       '#3584E4',
    'VirtualBox':         '#183A6E',
    'Podman Desktop':     '#892CA0',
    'Docker Desktop':     '#2496ED',
    'Podman':             '#892CA0',

    // ── PDF (7) ──
    'Evince':             '#3584E4',
    'Atril':              '#3584E4',
    'Xreader':            '#3584E4',
    'Zathura':            '#3584E4',
    'Mu PDF Viewer':      '#3584E4',
    'Papers':             '#3584E4',
    'PDF Arranger':       '#3584E4',

    // ── Audio Production (11) ──
    'Audacity':           '#0066FF',
    'LMMS':               '#FF6600',
    'Ardour':             '#C01C28',
    'Hydrogen':           '#0086D6',
    'Mixxx':              '#FF6600',
    'MuseScore':          '#3584E4',
    'Rosegarden':         '#3584E4',
    'VMPK':               '#3584E4',
    'Surge XT':           '#FF6600',
    'Carla':              '#FF6600',
    'Decibels':           '#3584E4',

    // ── Utilities (32) ──
    'Qalculate':          '#3584E4',
    'GNOME Calculator':   '#3584E4',
    'galculator':         '#3584E4',
    'SpeedCrunch':        '#3584E4',
    'Pavucontrol':        '#3584E4',
    'pavucontrol':        '#3584E4',
    'Alacarte':           '#3584E4',
    'gparted':            '#3584E4',
    'GParted':            '#3584E4',
    'BleachBit':          '#3584E4',
    'Stacer':             '#FF9800',
    'FlameShot':          '#FF6600',
    'Flameshot':          '#FF6600',
    'Screenshot Tool':    '#FF6600',
    'Peek':               '#FF6600',
    'Vokoscreen':         '#FF6600',
    'Kooha':              '#FF6600',
    'Gifcurry':           '#FF6600',
    'LocalSend':          '#3584E4',
    'Albert':             '#3584E4',
    'Plank':              '#3584E4',
    'Variety':            '#FF6600',
    'Conky':              '#3584E4',
    'yt-dlp':             '#FF6600',
    'Ulauncher':          '#3584E4',
    'Rofi':               '#3584E4',
    'Polybar':            '#3584E4',
    'Timeshift':          '#3584E4',
    'Syncthing GTK':      '#3584E4',
    'Syncthing':          '#3584E4',
    'Nitrogen':           '#3584E4',
    'feh':                '#3584E4',
    'Parcellite':         '#3584E4',
    'ClipIt':             '#3584E4',
    'Redshift':           '#FF6600',
    'Night Light':        '#FF6600',
    'dconf Editor':       '#3584E4',

    // ── Finance (4) ──
    'GnuCash':            '#18A303',
    'HomeBank':           '#E01B24',
    'Skrooge':            '#3584E4',
    'Firefly III':        '#FF6600',

    // ── System Monitors (6) ──
    'Htop':               '#FF6600',
    'btop':               '#FF6600',
    'bashtop':            '#FF6600',
    'ytop':               '#FF6600',
    'Glances':            '#FF6600',
    'Resources':          '#FF6600',

    // ── Fetch / Terminal Fun (8) ──
    'Neofetch':           '#3584E4',
    'Fastfetch':          '#3584E4',
    'cmatrix':            '#26A269',
    'cowsay':             '#3584E4',
    'figlet':             '#3584E4',
    'Oneko':              '#FF6600',
    'xeyes':              '#3584E4',
    'xclock':             '#3584E4',
};


const WindowTitleIndicator = GObject.registerClass(
    class WindowTitleIndicator extends PanelMenu.Button {
        _init(settings) {
            super._init();

            this._settings = settings;

            // ── Primary menu (left-click) ──
            this._menu = new AppMenu(this);
            this.setMenu(this._menu);
            this._menu.setSourceAlignment(0.3);
            Main.panel.menuManager.addMenu(this._menu);

            this._desaturate_effect = new Clutter.DesaturateEffect();

            this._box = new St.BoxLayout({ style_class: 'panel-button' });

            this._icon = new St.Icon({});
            this._icon.set_fallback_gicon(null);
            this._box.add_child(this._icon);

            this._icon_padding = new St.Label({ y_align: Clutter.ActorAlign.CENTER });
            this._box.add_child(this._icon_padding);

            this._workspace = new St.Label({ y_align: Clutter.ActorAlign.CENTER });
            this._box.add_child(this._workspace);

            this._app = new St.Label({ y_align: Clutter.ActorAlign.CENTER });
            this._box.add_child(this._app);

            this._window_count = new St.Label({ y_align: Clutter.ActorAlign.CENTER });
            this._box.add_child(this._window_count);

            this._app_padding = new St.Label({ y_align: Clutter.ActorAlign.CENTER });
            this._box.add_child(this._app_padding);

            this._title = new St.Label({ y_align: Clutter.ActorAlign.CENTER });
            this._box.add_child(this._title);

            this.add_child(this._box);

            // ── Signals ──
            global.display.connectObject(
                'notify::focus-window',
                this._on_focused_window_changed.bind(this),
                this
            );
            St.TextureCache.get_default().connectObject(
                'icon-theme-changed',
                this._on_focused_window_changed.bind(this),
                this
            );

            // ── Workspace signal ──
            if (global.workspace_manager) {
                global.workspace_manager.connectObject(
                    'active-workspace-changed',
                    this._on_workspace_changed.bind(this),
                    this
                );
            }
        }

        destroy() {
            global.display.disconnectObject(this);
            St.TextureCache.get_default().disconnectObject(this);
            if (this._focused_window)
                this._focused_window.disconnectObject(this);
            if (global.workspace_manager)
                global.workspace_manager.disconnectObject(this);
            this._focused_window = null;
            this._focused_app = null;
            Main.panel.menuManager.removeMenu(this.menu);
            this.menu = null;
            super.destroy();
        }

        _fade_in() {
            this.remove_all_transitions();
            // Appear at opacity 0 first so the gap is reserved while the
            // indicator is still invisible — surrounding items shift while
            // nothing is visible, then the indicator fades in smoothly.
            this.opacity = 0;
            this.show();
            this.reactive = true;
            if (!_motion_allowed()) {
                this.opacity = 255;
                return;
            }
            this.ease({
                opacity: 255,
                duration: this._ease_time,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        _fade_out() {
            this.remove_all_transitions();
            this.reactive = false;
            if (!_motion_allowed()) {
                this.opacity = 0;
                this.hide();
                return;
            }
            this.ease({
                opacity: 0,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                duration: this._ease_time,
                onComplete: () => this.hide(),
            });
        }

        _sync() {
            this.remove_all_transitions();
            if (!_motion_allowed()) {
                this.opacity = 0;
                this._set_window_app();
                this._set_window_title();
                this._update_workspace();
                this._update_window_count();
                this._fade_in();
                return;
            }
            this.ease({
                opacity: 0,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                duration: this._ease_time,
                onComplete: () => {
                    this._set_window_app();
                    this._set_window_title();
                    this._update_workspace();
                    this._update_window_count();
                    this._fade_in();
                },
            });
        }

        _on_focused_window_changed() {
            if (Main.sessionMode.isLocked)
                return;

            if (this._focused_window)
                this._focused_window.disconnectObject(this);
            this._focused_window = global.display.get_focus_window();

            if (this._focused_window &&
                (!this._focused_window.skip_taskbar ||
                    (this._focused_window.get_window_type() == Meta.WindowType.MODAL_DIALOG))) {
                this._sync();

                if (this._settings.get_boolean('show-title'))
                    this._focused_window.connectObject(
                        'notify::title',
                        this._sync.bind(this),
                        this
                    );
            }

            if ((!this._focused_window && !this._menu.isOpen) ||
                (this._focused_window && this._focused_window.skip_taskbar &&
                    this._focused_window.get_window_type() != Meta.WindowType.MODAL_DIALOG))
                this._fade_out();
        }

        _on_workspace_changed() {
            this._update_workspace();
        }

        _set_window_app() {
            this._focused_app = Shell.WindowTracker.get_default().get_window_app(
                this._focused_window
            );

            if (this._focused_app) {
                this._icon.set_gicon(this._focused_app.get_icon());
                this._app.set_text(this._focused_app.get_name());
                this.menu.setApp(this._focused_app);
            }

            // ── Apply per-app color on every window switch (requires colored-icon ON) ──
            const fontSize = this._settings.get_int('font-size');
            if (this._settings.get_boolean('colored-icon') && this._settings.get_boolean('per-app-color')) {
                if (this._focused_app) {
                    const color = this._get_app_color(this._focused_app.get_name());
                    this._app.set_style(`font-size: ${fontSize}px; color: ${color};`);
                } else {
                    this._app.set_style(`font-size: ${fontSize}px;`);
                }
            } else {
                this._app.set_style(`font-size: ${fontSize}px;`);
            }
        }

        _set_window_title() {
            if (this._focused_window)
                this._title.set_text(this._focused_window.get_title());
        }

        // ── Workspace indicator ──
        _update_workspace() {
            if (!this._settings.get_boolean('show-workspace')) {
                this._workspace.set_text('');
                return;
            }
            const wm = global.workspace_manager;
            if (!wm) return;
            const idx = wm.get_active_workspace_index();
            this._workspace.set_text(`[${idx + 1}] `);
        }

        // ── Window count badge ──
        _update_window_count() {
            if (!this._settings.get_boolean('show-window-count') || !this._focused_app) {
                this._window_count.set_text('');
                return;
            }
            const win_count = this._focused_app.get_n_windows();
            if (win_count > 1) {
                this._window_count.set_text(` (${win_count})`);
            } else {
                this._window_count.set_text('');
            }
        }

        // ── Per-app color ──
        _get_app_color(app_name) {
            if (!app_name) return null;
            return APP_COLORS[app_name] || '#FFFFFF';
        }

    }
);


export default class WindowTitleProExtension extends Extension {
    _on_settings_changed() {
        this._indicator._icon.visible = this._settings.get_boolean('show-icon');
        this._indicator._app.visible = this._settings.get_boolean('show-app');
        this._indicator._title.visible = this._settings.get_boolean('show-title');
        this._indicator._ease_time = this._settings.get_int('ease-time');

        if (this._settings.get_boolean('show-icon'))
            this._indicator._icon_padding.set_text('   ');
        else
            this._indicator._icon_padding.set_text('');

        // ── Workspace indicator visibility ──
        this._indicator._workspace.visible = this._settings.get_boolean('show-workspace');
        if (this._settings.get_boolean('show-workspace'))
            this._indicator._update_workspace();

        // ── Window count visibility ──
        this._indicator._window_count.visible = this._settings.get_boolean('show-window-count');
        if (this._settings.get_boolean('show-window-count'))
            this._indicator._update_window_count();

        if (this._settings.get_boolean('show-app') &&
            this._settings.get_boolean('show-title'))
            this._indicator._app_padding.set_text(this._settings.get_string('separator'));
        else
            this._indicator._app_padding.set_text('');

        if (this._settings.get_boolean('colored-icon')) {
            this._indicator._icon.set_style_class_name('');
            this._indicator.remove_effect(this._indicator._desaturate_effect);
        } else {
            this._indicator._icon.set_style_class_name('app-menu-icon');
            this._indicator.add_effect(this._indicator._desaturate_effect);
        }

        // ── Fine-tune position ──
        this._apply_position();

        this._indicator._icon.set_icon_size(this._settings.get_int('icon-size'));

        if (this._settings.get_boolean('fixed-width'))
            this._indicator.set_width(
                Main.panel.width * this._settings.get_int('width') / 100
            );
        else
            this._indicator.set_width(-1);

        // ── Font size ──
        const fontSize = this._settings.get_int('font-size');
        const style = `font-size: ${fontSize}px;`;
        this._indicator._icon.set_style(style);
        this._indicator._app.set_style(style);
        this._indicator._title.set_style(style);

        // ── Per-app color ──
        this._apply_per_app_color();

        this._indicator._on_focused_window_changed();
    }

    // ── Apply per-app color to app label (requires colored-icon ON) ──
    _apply_per_app_color() {
        const fontSize = this._settings.get_int('font-size');
        if (!this._settings.get_boolean('colored-icon') || !this._settings.get_boolean('per-app-color') || !this._indicator._focused_app) {
            this._indicator._app.set_style(`font-size: ${fontSize}px;`);
            return;
        }
        const app_name = this._indicator._focused_app.get_name();
        const color = this._indicator._get_app_color(app_name);
        this._indicator._app.set_style(`font-size: ${fontSize}px; color: ${color};`);
    }

    _setup_keybinding() {
        Main.wm.removeKeybinding('toggle-shortcut');
        Main.wm.addKeybinding(
            'toggle-shortcut',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            () => this._toggle_visibility()
        );
    }

    _toggle_visibility() {
        if (!this._indicator)
            return;

        if (this._indicator.visible) {
            this._indicator.hide();
        } else {
            this._indicator.show();
            this._indicator._on_focused_window_changed();
        }
    }

    _get_panel_box(pos) {
        if (pos === 'center') return Main.panel._centerBox;
        if (pos === 'right') return Main.panel._rightBox;
        return Main.panel._leftBox;
    }

    _move_to_box(box) {
        const container = this._indicator.container;
        const parent = container.get_parent();
        if (parent && parent !== box) {
            parent.remove_child(container);
            box.add_child(container);
        }
    }

    // ── Fine-tune position within the chosen panel box ──
    // 0 = default spot (last slot of the box), negative = shift left,
    // positive = shift right. Clamped to the box bounds.
    _apply_offset() {
        const box = this._indicator.container.get_parent();
        if (!box)
            return;

        const offset = this._settings.get_int('panel-offset');
        const children = box.get_children();
        const current = children.indexOf(this._indicator.container);
        if (current === -1)
            return;

        const base = children.length - 1;
        const target = Math.max(0, Math.min(base, base + offset));
        if (target !== current)
            box.set_child_at_index(this._indicator.container, target);
    }

    // ── Anchor mode: keep the indicator right after the workspace pill ──
    // On the left side the native workspace indicator (GNOME 51 "Activities"
    // pill) leads the box with this indicator right after it and everything
    // else (e.g. Global Menu buttons) after that. Global Menu re-creates its
    // buttons at fixed slots on every focus change, so the order is asserted
    // again after the box settles (see _schedule_position_reapply).
    _apply_anchor() {
        const box = Main.panel._leftBox;
        const container = this._indicator.container;
        if (container.get_parent() !== box)
            return;

        const pill_button = Main.panel.statusArea['activities'];
        const pill = pill_button?.container;
        const children = box.get_children();
        const pill_idx = (pill && pill.get_parent() === box)
            ? children.indexOf(pill)
            : -1;

        // No workspace pill in the left box → end-anchored placement.
        if (pill_idx === -1) {
            this._apply_offset();
            return;
        }

        // The pill leads the box unless a foreign item (e.g. Kiwi Menu) sits
        // first — then the pill goes right after it. Hidden pill stays put.
        let pill_target = pill_idx;
        if (pill_button.visible && children[0] !== pill) {
            pill_target = 1;
            if (pill_idx !== pill_target)
                box.set_child_at_index(pill, pill_target);
        }

        const offset = this._settings.get_int('panel-offset');
        const our_target = Math.max(
            0,
            Math.min(box.get_n_children() - 1, pill_target + 1 + offset)
        );
        if (box.get_children().indexOf(container) !== our_target)
            box.set_child_at_index(container, our_target);
    }

    _apply_position() {
        if (this._settings.get_string('panel-position') === 'left' &&
            this._settings.get_boolean('anchor-workspaces'))
            this._apply_anchor();
        else
            this._apply_offset();
    }

    _schedule_position_reapply() {
        if (this._positionIdle)
            return;
        this._positionIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._positionIdle = 0;
            if (this._settings && this._indicator)
                this._apply_position();
            return GLib.SOURCE_REMOVE;
        });
    }

    enable() {
        this._settings = this.getSettings();

        this._indicator = new WindowTitleIndicator(this._settings);

        this._on_settings_changed();
        this._settings.connectObject(
            'changed',
            this._on_settings_changed.bind(this),
            this
        );
        this._settings.connectObject(
            'changed::panel-position',
            () => {
                const pos = this._settings.get_string('panel-position');
                const box = this._get_panel_box(pos);
                this._move_to_box(box);
                this._apply_position();
            },
            this
        );

        // ── Always add via addToStatusArea (left only — safest in GNOME 50) ──
        Main.panel.addToStatusArea(
            'window-title-pro-indicator',
            this._indicator,
            -1,
            'left'
        );

        // ── Then move to desired position if not left ──
        const pos = this._settings.get_string('panel-position');
        if (pos !== 'left') {
            const box = this._get_panel_box(pos);
            this._move_to_box(box);
        }

        // ── Fine-tune position ──
        this._apply_position();

        // ── Keyboard shortcut ──
        this._setup_keybinding();

        // ── Re-assert position when the left box changes (e.g. Global Menu
        //    rebuilds its buttons on every focus change) ──
        // NB: GNOME 51 has no 'child-reordered' signal on the panel boxes.
        Main.panel._leftBox.connectObject(
            'child-added',
            () => this._schedule_position_reapply(),
            'child-removed',
            () => this._schedule_position_reapply(),
            this
        );
    }

    disable() {
        Main.wm.removeKeybinding('toggle-shortcut');

        Main.panel?._leftBox.disconnectObject(this);
        if (this._positionIdle) {
            GLib.source_remove(this._positionIdle);
            this._positionIdle = 0;
        }

        this._settings.disconnectObject(this);
        this._settings = null;

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
