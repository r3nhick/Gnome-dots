import { ScreenCorner } from "./ScreenCorner.js";

/**
 * @typedef {Position}
 * @property {int} x
 * @property {int} y
 */

/**
 * @typedef {Dimensions}
 * @property {int} width
 * @property {int} height
 */

export default class HandledWindow {
  metaWindow = null;
  settings = null;

  wasAbove = null;
  wasHidden = null;
  wasStuck = null;

  unmanagedSignal = null;
  sizeChangedSignal = null;

  constructor(metaWindow, settings) {
    this.metaWindow = metaWindow;
    this.settings = settings;
  }

  /**
   * Apply changes to the window according to user preferences
   */
  async handle() {
    // If the window was maximized, unmaximize it
    if (
      this.metaWindow.maximized_horizontally ||
      this.metaWindow.maximized_vertically
    ) {
      this.metaWindow.unmaximize();
      await new Promise((resolve) => {
        const sizeChangedSignal = this.metaWindow.connect(
          "size-changed",
          () => {
            this.metaWindow.disconnect(sizeChangedSignal);
            resolve();
          },
        );
      });
    }

    // Resize the window again once the initial resizing is done
    this.sizeChangedSignal = this.metaWindow.connect("size-changed", () => {
      this.metaWindow.disconnect(this.sizeChangedSignal);
      this.sizeChangedSignal = null;
      this.moveResize();
    });

    this.moveResize();

    // Make window always above
    this.handleAbove();

    // Hide window from overviews
    this.handleHidden();

    // Show window on all workspaces
    this.handleStuck();
  }

  handleAbove() {
    if (this.settings.get_boolean("top")) {
      this.wasAbove = this.metaWindow.is_above();
      this.metaWindow.make_above();
    } else if (this.wasAbove === false) {
      this.metaWindow.unmake_above();
    }
  }

  handleHidden() {
    if (this.settings.get_boolean("hide")) {
      this.wasHidden = this.metaWindow.is_skip_taskbar();
      this.metaWindow.hide_from_window_list();
    } else if (this.wasHidden === false) {
      this.metaWindow.show_in_window_list();
    }
  }

  handleStuck() {
    if (this.settings.get_boolean("stick")) {
      this.wasStuck = this.metaWindow.is_on_all_workspaces();
      this.metaWindow.stick();
    } else if (this.wasStuck === false) {
      this.metaWindow.unstick();
    }
  }

  /**
   * Undo changes to tha window made by the handle method
   */
  unhandle() {
    // Disconnect signals
    if (this.unmanagedSignal) {
      this.metaWindow.disconnect(this.unmanagedSignal);
      this.unmanagedSignal = null;
    }
    if (this.sizeChangedSignal) {
      this.metaWindow.disconnect(this.sizeChangedSignal);
      this.sizeChangedSignal = null;
    }

    // Revert changes made to window
    if (!this.wasAbove) this.metaWindow.unmake_above();
    if (!this.wasHidden) this.metaWindow.show_in_window_list();
    if (!this.wasStuck) this.metaWindow.unstick();
  }

  /**
   * Move and resize window based on preferences
   * @param {int|null} corner
   */
  moveResize(corner) {
    if (!corner) {
      corner = this.settings.get_int("corner");
    }

    // Get monitor work area
    const workspace = global.workspace_manager.get_active_workspace();
    const monitorIndex = this.metaWindow.get_monitor();
    const workArea = workspace.get_work_area_for_monitor(monitorIndex);

    // Calculate window dimensions
    const dimensions = this.#calculateDimensions(workArea);

    // Calculate window position
    const position = this.#calculatePosition(workArea, corner, dimensions);

    // Move and resize
    this.metaWindow.move_resize_frame(
      false,
      position.x,
      position.y,
      dimensions.width,
      dimensions.height,
    );
  }

  /**
   * Calculate new window dimensions based on current diagonal length
   * @param {MtkRectangle} workArea
   * @returns {Dimensions}
   */
  #calculateDimensions(workArea) {
    const rectangle = this.metaWindow.get_frame_rect();
    const oldDiagonal = Math.sqrt(
      rectangle.width * rectangle.width + rectangle.height * rectangle.height,
    );

    let newDiagonal;
    if (this.settings.get_boolean("use-relative")) {
      newDiagonal =
        (Math.sqrt(
          workArea.width * workArea.width + workArea.height * workArea.height,
        ) *
          this.settings.get_int("diagonal-relative")) /
        100;
    } else {
      newDiagonal = this.settings.get_int("diagonal");
    }

    const coef = newDiagonal / oldDiagonal;
    const width = Math.ceil(rectangle.width * coef);
    const height = Math.ceil(rectangle.height * coef);

    return {
      width: width,
      height: height,
    };
  }

  /**
   * Calculate new window position
   * @param {MtkRectangle} workArea
   * @param {int} corner
   * @param {Dimensions} dimensions
   * @returns {Position}
   */
  #calculatePosition(workArea, corner, dimensions) {
    if (!dimensions) {
      const rectangle = this.metaWindow.get_frame_rect();
      dimensions = { width: rectangle.width, height: rectangle.height };
    }
    const marginX = this.settings.get_int("margin-x");
    const marginY = this.settings.get_int("margin-y");
    let x, y;
    switch (corner) {
      case ScreenCorner.TL:
        x = workArea.x + marginX;
        y = workArea.y + marginY;
        break;
      case ScreenCorner.TR:
        x = workArea.x + workArea.width - dimensions.width - marginX;
        y = workArea.y + marginY;
        break;
      case ScreenCorner.BL:
        x = workArea.x + marginX;
        y = workArea.y + workArea.height - dimensions.height - marginY;
        break;
      default:
        x = workArea.x + workArea.width - dimensions.width - marginX;
        y = workArea.y + workArea.height - dimensions.height - marginY;
        break;
    }
    return {
      x: x,
      y: y,
    };
  }
}
