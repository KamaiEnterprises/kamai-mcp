import { useEffect, useState } from "react";

import { init, reportSize } from "./bridge";

export function useWidgetData<T>(): T | null {
  const [data, setData] = useState<T | null>(null);

  useEffect(() => init((value) => setData(value as T)), []);

  useEffect(() => {
    reportSize();
  }, [data]);

  return data;
}
