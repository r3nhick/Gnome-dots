import * as Config from "resource:///org/gnome/shell/misc/config.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import Shell from "gi://Shell";
import HandledWindow from "./js/HandledWindow.js";
import Condition from "./js/Condition.js";
import GLib from "gi://GLib";

export default class InPicture extends Extension {
  constructor(metadata) {
    super(metadata);
    this.windowCreatedSignal = null;
    this.settings = null;
    this.settingsChangedSignal = null;
    this.windows = [];
  }

  enable() {
    this.settings = this.getSettings();
    this.windowCreatedSignal = global.display.connect(
      "window-created",
      (metaDisplay, metaWindow) =>
        this.handleNewWindow(metaDisplay, metaWindow),
    );
    this.settings.set_string("gnome-version", Config.PACKAGE_VERSION);

    // Migrate old identifiers (stored in arrays) to conditions (stored in objects)
    // PENDING REMOVAL together with the identifiers key from the schema
    const conditions = [];
    const identifiers = this.settings.get_value("identifiers").deep_unpack();
    if (identifiers.length) {
      for (const pair of identifiers) {
        conditions.push(
          new Condition({ title: pair[0], app: pair[1] }).toObject(),
        );
      }
      this.settings.set_value(
        "conditions",
        new GLib.Variant("aa{sv}", conditions),
      );
      this.settings.set_value("identifiers", new GLib.Variant("aas", []));
    }

    // Listen to changes in settings
    this.settingsChangedSignal = this.settings.connect("changed", (_, key) => {
      if (key === "conditions") {
        this.checkAllWindows();
      } else {
        for (const handledWindow of this.windows) {
          switch (key) {
            case "top":
              handledWindow.handleAbove();
              break;
            case "hide":
              handledWindow.handleHidden();
              break;
            case "stick":
              handledWindow.handleStuck();
              break;
          }
        }
      }
    });

    // Handle all existing windows
    this.checkAllWindows();
  }

  disable() {
    // Disconnect signals
    if (this.windowCreatedSignal) {
      global.display.disconnect(this.windowCreatedSignal);
      this.windowCreatedSignal = null;
    }
    if (this.settingsChangedSignal) {
      this.settings.disconnect(this.settingsChangedSignal);
      this.settingsChangedSignal = null;
    }

    this.settings = null;

    // Unhandle all handled windows
    for (const handledWindow of this.windows) {
      handledWindow.unhandle();
    }
    this.windows = [];
  }

  /**
   * Check and handle all existing windows
   */
  checkAllWindows() {
    for (const windowActor of global.get_window_actors()) {
      const metaWindow = windowActor.meta_window;
      const shouldHandle = this.shouldHandle(metaWindow);
      const handledWindow = this.windows.find(
        (h) => h.metaWindow.get_id() === metaWindow.get_id(),
      );
      const isHandled = handledWindow !== undefined;

      if (shouldHandle && !isHandled) this.handleExistingWindow(metaWindow);
      if (!shouldHandle && isHandled) this.unhandleWindow(handledWindow);
    }
  }

  /**
   * Handle the window as newly opened
   * @param {MetaDisplay} metaDisplay
   * @param {MetaWindow} metaWindow
   */
  handleNewWindow(metaDisplay, metaWindow) {
    const previouslyFocused = metaDisplay.get_focus_window();

    // Wait for the first frame to happen
    const wrapper = metaWindow.get_compositor_private();
    const windowFirstSignal = wrapper.connect("first-frame", () => {
      wrapper.disconnect(windowFirstSignal);

      if (!this.shouldHandle(metaWindow)) return;

      // If some other window was in focus, focus it again
      if (metaWindow.has_focus() && previouslyFocused) {
        Main.activateWindow(previouslyFocused);
      }

      this.handleExistingWindow(metaWindow);
    });
  }

  /**
   * Handle the window as already open
   * @param {MetaWindow} metaWindow
   */
  handleExistingWindow(metaWindow) {
    const handledWindow = new HandledWindow(metaWindow, this.settings);
    this.windows.push(handledWindow);

    handledWindow.handle();

    // Unhandle the window once it's closed
    handledWindow.unmanagedSignal = handledWindow.metaWindow.connect(
      "unmanaged",
      () => {
        this.unhandleWindow(handledWindow);
      },
    );
  }

  /**
   * Reverts changes made to a window
   * @param {HandledWindow} handledWindow
   */
  unhandleWindow(handledWindow) {
    handledWindow.unhandle();

    // Remove from the list of managed windows
    const index = this.windows.indexOf(handledWindow);
    if (index > -1) this.windows.splice(index);
  }

  /**
   * Checks if the window contains user-configured identifiers
   * @param {MetaWindow} metaWindow
   * @returns {bool}
   */
  shouldHandle(metaWindow) {
    const conditions = this.settings.get_value("conditions").deep_unpack();
    const windowTracker = Shell.WindowTracker.get_default();
    let matched = false;
    for (const object of conditions) {
      const condition = new Condition(object);
      if (condition.title) {
        const title = metaWindow.get_title();
        if (!title) {
          continue;
        }
        const normalized = title.replace(/\u00A0/g, " ").normalize("NFC");
        if (condition.titleExact && normalized === condition.title) {
          // Titles are exactly matching
        } else if (
          !condition.titleExact &&
          normalized.includes(condition.title)
        ) {
          // Title contains substring
        } else {
          // Title is not matching; continute to next condition
          continue;
        }
      }
      if (condition.app) {
        const app = windowTracker.get_window_app(metaWindow).get_id();
        if (!app) {
          continue;
        }
        if (app !== condition.app) {
          continue;
        }
      }
      matched = true;
      break;
    }
    return matched;
  }
}
