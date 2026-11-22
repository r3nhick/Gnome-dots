import GLib from "gi://GLib";

export default class Condition {
  title = null;
  titleExact = null;
  app = null;

  constructor(object) {
    this.title = object.title ?? null;
    if (this.title && typeof this.title === "object") {
      this.title = this.title.get_string()[0];
    }
    this.titleExact = object.titleExact ?? null;
    if (this.titleExact && typeof this.titleExact === "object") {
      this.titleExact = this.titleExact.get_boolean();
    }
    this.app = object.app ?? null;
    if (this.app && typeof this.app === "object") {
      this.app = this.app.get_string()[0];
    }
  }

  toObject() {
    return {
      title: GLib.Variant.new_string(this.title ?? ""),
      titleExact: GLib.Variant.new_boolean(this.titleExact ?? false),
      app: GLib.Variant.new_string(this.app ?? ""),
    };
  }
}
