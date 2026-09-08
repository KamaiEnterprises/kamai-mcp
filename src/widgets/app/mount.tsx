import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

export function mount(Widget: ComponentType, name: string): void {
  document.documentElement.lang = "en";
  document.title = `Kamai ${name}`;
  createRoot(document.getElementById("root")!).render(<Widget />);
}
