// NAME: Quick Exit
// VERSION: 46, 47, 48, 49, 50, 51
import { Extension, InjectionManager } from "resource:///org/gnome/shell/extensions/extension.js";
import { EndSessionDialog } from "resource:///org/gnome/shell/ui/endSessionDialog.js";
// src/extension.ts
var QuickExitExtension = class extends Extension {
	_injectionManager = null;
	enable() {
		const settings = this.getSettings();
		this._injectionManager = new InjectionManager();
		this._injectionManager.overrideMethod(EndSessionDialog.prototype, "_startTimer", (originalStartTimer) => function() {
			this._totalSecondsToStayOpen = Math.min(this._totalSecondsToStayOpen, settings.get_int("timeout-seconds"));
			return originalStartTimer.call(this);
		});
	}
	disable() {
		this._injectionManager?.clear();
		this._injectionManager = null;
	}
};
export { QuickExitExtension as default };
