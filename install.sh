#!/usr/bin/env bash
# Gnome-dots installer — r3nhick
set -euo pipefail
cd "$(dirname "$0")"
D="$PWD"
SHARE="${XDG_DATA_HOME:-$HOME/.local/share}"

echo ":: Wallpapers"
mkdir -p "$SHARE/backgrounds"
cp -n wallpapers/* "$SHARE/backgrounds/"

echo ":: GTK / Shell theme (Tahoe-Soft)"
mkdir -p "$HOME/.themes"
cp -r themes/* "$HOME/.themes/"

echo ":: Cursors (Remus-White)"
mkdir -p "$HOME/.icons"
tar -xJf cursors/Remus-White.tar.xz -C "$HOME/.icons"

echo ":: Icons (Tahoe-BlueGray + Tahoe-Default)"
cat icons/Tahoe-icons.tar.xz.part* | tar -xJf - -C "$HOME/.icons"

echo ":: Extensions"
EXT_DIR="$SHARE/gnome-shell/extensions"
mkdir -p "$EXT_DIR"
cp -r extensions/* "$EXT_DIR/"
for repo in snowcast desktop-widgets; do
  tmp=$(mktemp -d)
  git clone --depth 1 "https://github.com/r3nhick/$repo.git" "$tmp/$repo"
  if [ -x "$tmp/$repo/install.sh" ]; then (cd "$tmp/$repo" && ./install.sh)
  else uuid=$(python3 -c "import json;print(json.load(open('$tmp/$repo/metadata.json'))['uuid'])"); rm -rf "$EXT_DIR/$uuid"; cp -r "$tmp/$repo" "$EXT_DIR/$uuid"; rm -rf "$EXT_DIR/$uuid/.git"; fi
  rm -rf "$tmp"
done
for e in "$EXT_DIR"/*/schemas; do [ -d "$e" ] && glib-compile-schemas "$e" || true; done

echo ":: dconf settings"
sed "s#@HOME@#$HOME#g" dconf/desktop.ini | dconf load /
dconf load / < dconf/extensions.ini
dconf write /org/gnome/shell/enabled-extensions "['Bluetooth-Battery-Meter@maniacx.github.com', 'CoverflowAltTab@palatis.blogspot.com', 'add-to-desktop@tommimon.github.com', 'app-volumes@kapustota.github.io', 'appgrid-uninstall@i-soumya18.github.io', 'appindicatorsupport@rgcjonas.gmail.com', 'caffeine@patapon.info', 'color-picker@tuberry', 'copyous@boerdereinar.dev', 'dash-to-dock@micxgx.gmail.com', 'drive-menu@gnome-shell-extensions.gcampax.github.com', 'escape-to-close-overview@anatolyeltsov', 'globalmenu@ShiroOSL.github.io', 'gtk4-ding@smedius.gitlab.com', 'in-picture@filiprund.cz', 'isle@zickrian.github.io', 'just-perfection-desktop@just-perfection', 'kiwimenu@kemma', 'notification-timeout@chlumskyvaclav.gmail.com', 'open-desktop-location@nattesh', 'pin-window@eltaweel068', 'quick-exit@baxyz.dev', 'quick-settings-avatar@d-go', 'shotzy@SamkitJain660.github.io', 'system-monitor@gnome-shell-extensions.gcampax.github.com', 'user-theme@gnome-shell-extensions.gcampax.github.com', 'window-title-pro@eprahemi.github.io', 'snowcast@r3nhick', 'desktop-widgets@r3nhick']"
dconf write /org/gnome/shell/favorite-apps "['com.mitchellh.ghostty.desktop', 'org.gnome.Nautilus.desktop', 'firefox.desktop', 'com.anthropic.Claude.desktop', 'org.gnome.TextEditor.desktop', 'nvim.desktop', 'android-studio.desktop', 'org.telegram.desktop.desktop', 'spotify.desktop', 'io.github.shiftey.Desktop.desktop', 'io.github.alainm23.planify.desktop']"

echo ":: Done. Log out and back in (Wayland) to reload GNOME Shell."
