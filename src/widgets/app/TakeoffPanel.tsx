import { useMemo, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Hash, Ruler, Shapes } from "lucide-react";

import { formatNumber, rgba, scaleWarning } from "./format";
import { Card, ProcessingState } from "./shared";
import type { TakeoffData, TakeoffRow } from "./types";

type SortKey = "cls" | "count" | "area" | "len";

export function TakeoffPanel({ data, compact = false }: { data: TakeoffData; compact?: boolean }) {
  const [sortKey, setSortKey] = useState<SortKey>("area");
  const [direction, setDirection] = useState<-1 | 1>(-1);

  const groups = useMemo(() => {
    const grouped = new Map<string, TakeoffRow[]>();
    for (const row of data.rows ?? []) {
      const rows = grouped.get(row.group) ?? [];
      rows.push(row);
      grouped.set(row.group, rows);
    }
    for (const rows of grouped.values()) {
      rows.sort((left, right) => {
        const a = left[sortKey];
        const b = right[sortKey];
        if (typeof a === "string" && typeof b === "string") return direction * a.localeCompare(b);
        return direction * ((Number(a) || 0) - (Number(b) || 0));
      });
    }
    return [...grouped.entries()];
  }, [data.rows, direction, sortKey]);

  if (data.state === "processing" || data.state === "failed") {
    return <ProcessingState failed={data.state === "failed"} progress={data.progress} message={data.error_message} />;
  }

  const totals = data.totals ?? { count: 0, area: 0, len: 0 };
  const units = data.units ?? { area: "m²", length: "m" };
  const warning = scaleWarning(data);

  const sort = (key: SortKey) => {
    if (key === sortKey) setDirection((value) => (value === -1 ? 1 : -1));
    else {
      setSortKey(key);
      setDirection(key === "cls" ? 1 : -1);
    }
  };

  const heading = (label: string, key: SortKey, numeric = false) => (
    <button
      className={`flex w-full items-center gap-1 text-xs font-semibold uppercase tracking-wide hover:text-primary ${numeric ? "justify-end" : "justify-start"}`}
      onClick={() => sort(key)}
    >
      {label}
      {sortKey === key && (direction < 0 ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
    </button>
  );

  return (
    <div className={compact ? "" : "space-y-3"}>
      <div className="mb-3 grid grid-cols-3 gap-2">
        <Card className="flex items-center gap-2 p-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><Hash className="h-4 w-4" /></span>
          <div><div className="text-[11px] text-base-content/50">Objects</div><div className="font-semibold tabular-nums">{totals.count.toLocaleString()}</div></div>
        </Card>
        <Card className="flex items-center gap-2 p-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary/10 text-secondary"><Shapes className="h-4 w-4" /></span>
          <div><div className="text-[11px] text-base-content/50">Area</div><div className="font-semibold tabular-nums">{formatNumber(totals.area)} <small>{units.area}</small></div></div>
        </Card>
        <Card className="flex items-center gap-2 p-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-success/10 text-success"><Ruler className="h-4 w-4" /></span>
          <div><div className="text-[11px] text-base-content/50">Length</div><div className="font-semibold tabular-nums">{formatNumber(totals.len)} <small>{units.length}</small></div></div>
        </Card>
      </div>

      {warning && (
        <div className="alert alert-warning mb-3 py-2 text-sm">
          <AlertTriangle className="h-4 w-4" />
          <span>{warning}</span>
        </div>
      )}

      {groups.length ? (
        <Card className="overflow-x-auto">
          <table className="table table-sm w-full tabular-nums">
            <thead className="sticky top-0 z-10 bg-base-200 text-base-content/60">
              <tr>
                <th>{heading("Class", "cls")}</th>
                <th>{heading("Count", "count", true)}</th>
                <th>{heading(`Area (${units.area})`, "area", true)}</th>
                <th>{heading(`Length (${units.length})`, "len", true)}</th>
              </tr>
            </thead>
            {groups.map(([group, rows]) => (
              <tbody key={group}>
                <tr><th colSpan={4} className="bg-base-200/70 py-2 text-[11px] uppercase tracking-wider text-base-content/50">{group}</th></tr>
                {rows.map((row) => (
                  <tr key={`${group}-${row.cls}`} className="hover:bg-base-200/60">
                    <td className="max-w-52 truncate font-medium">
                      <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm" style={{ background: rgba(row.color, 0.9) }} />
                      {row.cls}
                    </td>
                    <td className="text-right">{row.count || "—"}</td>
                    <td className="text-right">{formatNumber(row.area)}</td>
                    <td className="text-right">{formatNumber(row.len)}</td>
                  </tr>
                ))}
              </tbody>
            ))}
            <tfoot className="bg-base-100 font-semibold">
              <tr>
                <td>Total</td>
                <td className="text-right">{totals.count || "—"}</td>
                <td className="text-right">{formatNumber(totals.area)}</td>
                <td className="text-right">{formatNumber(totals.len)}</td>
              </tr>
            </tfoot>
          </table>
        </Card>
      ) : (
        <Card className="p-8 text-center text-sm text-base-content/55">No measured shapes on this blueprint.</Card>
      )}
    </div>
  );
}
