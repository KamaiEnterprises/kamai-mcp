import { useEffect, useState } from "react";

import { getDisplayMode, onDisplayModeChange, type DisplayMode } from "./bridge";

// Mode is what the host granted, which is not always what we asked for. Layout should
// generally key off measured width instead — a host may hand us a wide inline card or
// a narrow fullscreen sheet — but mode is the right signal for the one decision width
// cannot answer: whether we grow to fit our content or own our own scroll.
export function useDisplayMode(): DisplayMode {
  const [mode, setMode] = useState<DisplayMode>(getDisplayMode);
  useEffect(() => onDisplayModeChange(setMode), []);
  return mode;
}
