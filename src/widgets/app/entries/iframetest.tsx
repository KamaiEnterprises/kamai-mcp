import { KamaiAppWidget } from "../KamaiAppWidget";
import { mount } from "../mount";

// The entry name is the widget id and is baked into every cached ui:// URI, so it
// stays "iframetest" even though the widget is now just the app.
mount(KamaiAppWidget, "Kamai");
