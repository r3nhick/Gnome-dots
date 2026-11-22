import Adw from "gi://Adw";
import Gio from "gi://Gio";
import Gtk from "gi://Gtk";
import GLib from "gi://GLib";
import {
  ExtensionPreferences,
  gettext as _,
} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";
import Condition from "./js/Condition.js";

export default class InPicturePreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();

    window.search_enabled = true;

    const builder = new Gtk.Builder();
    builder.set_translation_domain(this.uuid);
    builder.add_from_file(this.path + "/ui/prefs.ui");

    const page = builder.get_object("preferences_page");
    window.add(page);

    /* Position */
    const cornerRow = builder.get_object("corner_row");
    cornerRow.selected = settings.get_int("corner");
    cornerRow.connect("notify::selected", () => {
      settings.set_int("corner", cornerRow.get_selected());
    });

    const marginXAdjustment = builder.get_object("margin_x_adjustment");
    marginXAdjustment.value = settings.get_int("margin-x");
    marginXAdjustment.connect("value-changed", () => {
      settings.set_int("margin-x", marginXAdjustment.get_value());
    });

    const marginYAdjustment = builder.get_object("margin_y_adjustment");
    marginYAdjustment.value = settings.get_int("margin-y");
    marginYAdjustment.connect("value-changed", () => {
      settings.set_int("margin-y", marginYAdjustment.get_value());
    });

    /* Diagonal */
    const diagonalAdjustment = builder.get_object("diagonal_adjustment");
    diagonalAdjustment.connect("value-changed", () => {
      const useRelative = settings.get_boolean("use-relative");
      if (useRelative) {
        settings.set_int("diagonal-relative", diagonalAdjustment.get_value());
      } else {
        settings.set_int("diagonal", diagonalAdjustment.get_value());
      }
    });

    const diagonalUnits = builder.get_object("diagonal_units");
    diagonalUnits.connect("notify::selected", () => {
      settings.set_boolean("use-relative", diagonalUnits.get_selected() === 0);
      diagonalAdjustmentUpdate();
    });

    diagonalAdjustmentUpdate();

    function diagonalAdjustmentUpdate() {
      const useRelative = settings.get_boolean("use-relative");
      if (useRelative) {
        diagonalAdjustment.lower = 5;
        diagonalAdjustment.upper = 100;
        diagonalAdjustment.step_increment = 5;
        diagonalAdjustment.page_increment = 20;
        diagonalAdjustment.value = settings.get_int("diagonal-relative");
        diagonalUnits.set_selected(0);
      } else {
        diagonalAdjustment.lower = 100;
        diagonalAdjustment.upper = 1500;
        diagonalAdjustment.step_increment = 10;
        diagonalAdjustment.page_increment = 100;
        diagonalAdjustment.value = settings.get_int("diagonal");
        diagonalUnits.set_selected(1);
      }
    }

    /* Visibility */
    const stayOnTopRow = builder.get_object("stay_on_top_row");
    settings.bind("top", stayOnTopRow, "active", Gio.SettingsBindFlags.DEFAULT);

    const stickRow = builder.get_object("stick_row");
    settings.bind("stick", stickRow, "active", Gio.SettingsBindFlags.DEFAULT);

    const hideFromWindowList = builder.get_object("hide_from_window_list_row");
    settings.bind(
      "hide",
      hideFromWindowList,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );

    /* Conditions */
    const conditionsAdd = builder.get_object("conditions_add");
    conditionsAdd.connect("clicked", () => conditionsDialog.present(page));

    const conditionsDialog = builder.get_object("conditions_dialog");
    conditionsDialog.add_response("close", _("Close"));
    conditionsDialog.add_response("add", _("Add"));
    conditionsDialog.set_response_appearance(
      "add",
      Adw.ResponseAppearance.SUGGESTED,
    );

    const conditionTitleRow = builder.get_object("condition_title_row");
    conditionTitleRow.connect("entry-activated", () => {
      conditionsListSave("add");
    });

    const conditionTitleExactToggle = builder.get_object(
      "condition_title_exact_toggle",
    );

    const conditionAppRow = builder.get_object("condition_app_row");
    conditionAppRow.connect("entry-activated", () => {
      conditionsListSave("add");
    });

    conditionsDialog.connect("response", (_, response) => {
      conditionsListSave(response);
    });
    conditionsDialog.connect("map", () => {
      conditionTitleRow.grab_focus();
    });

    const conditionsList = builder.get_object("conditions_list");
    conditionsListPopulate();

    function conditionsListPopulate() {
      conditionsList.remove_all();

      const conditions = settings.get_value("conditions").deep_unpack();
      for (const object of conditions) {
        const condition = new Condition(object);
        const conditionRow = new Adw.ActionRow({
          title:
            condition.title +
            (condition.title && condition.app ? " • " : "") +
            "<i>" +
            (condition.app ?? "") +
            "</i>",
          selectable: false,
          activatable: true,
        });
        conditionsList.append(conditionRow);

        if (condition.titleExact) {
          const exactIcon = new Gtk.Image({
            icon_name: "font-select-symbolic",
            valign: Gtk.Align.CENTER,
            tooltip_text: _("Exact match required"),
          });
          conditionRow.add_suffix(exactIcon);
        }

        const deleteButton = new Gtk.Button({
          icon_name: "user-trash-symbolic",
          valign: Gtk.Align.CENTER,
          tooltip_text: _("Delete condition"),
        });
        conditionRow.add_suffix(deleteButton);
        deleteButton.add_css_class("circular");
        deleteButton.add_css_class("flat");
        deleteButton.connect("clicked", () => {
          settings.set_value(
            "conditions",
            new GLib.Variant(
              "aa{sv}",
              conditions.filter((o) => {
                const c = new Condition(o);
                return !(
                  c.title === condition.title && c.app === condition.app
                );
              }),
            ),
          );
          conditionsListPopulate();
        });
      }
    }

    function conditionsListSave(response) {
      if (response === "add") {
        const title = conditionTitleRow.text.trim();
        conditionTitleRow.text = "";
        const titleExact = conditionTitleExactToggle.active;
        const app = conditionAppRow.text.trim();
        conditionAppRow.text = "";

        if (title.length + app.length === 0) {
          const conditionWarning = builder.get_object("condition_warning");
          window.add_toast(conditionWarning);
        } else {
          const conditions = settings.get_value("conditions").deep_unpack();
          let duplicate = false;
          for (const object of conditions) {
            const condition = new Condition(object);
            if (condition.title === title && condition.app === app) {
              duplicate = true;
            }
          }
          if (!duplicate) {
            conditions.push(
              new Condition({ title, titleExact, app }).toObject(),
            );
            settings.set_value(
              "conditions",
              new GLib.Variant("aa{sv}", conditions),
            );
            conditionsListPopulate();
          }
        }
      }

      conditionsDialog.close();
    }
  }
}
