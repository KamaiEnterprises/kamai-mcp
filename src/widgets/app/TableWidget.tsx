import { useState } from "react";
import { AlertTriangle, Eye, LoaderCircle } from "lucide-react";

import { callTool, hostCanCallTools } from "./bridge";
import { BlueprintPanel } from "./BlueprintWidget";
import { ActionError, BrandHeader, Card, LoadingState } from "./shared";
import { highlightFor, idCount, rowElements } from "./table-rows";
import type { BlueprintData, Highlight, RowElements, TableColumn, TableData, TableRow } from "./types";
import { useWidgetData } from "./useWidgetData";

const RTL = new Set(["he", "ar", "fa", "ur", "yi"]);

type Plan = {
  row: TableRow;
  label: string;
  elements: RowElements;
  blueprintId: string;
  blueprint: BlueprintData;
  highlight: Highlight;
  /** How many of this blueprint's ids are no longer on it. */
  missing: number;
};

/** A tool result, or the error it carried. callTool hands back an error result as the
 * raw record, so a payload is recognised by shape rather than trusted. */
async function callKamai<T>(name: string, args: Record<string, unknown>, looksRight: (value: T) => boolean): Promise<T> {
  const value = await callTool<T>(name, args);
  if (value && typeof value === "object" && looksRight(value)) return value;
  const content = (value as { content?: Array<{ text?: string }> } | null)?.content;
  throw new Error(content?.[0]?.text || "Kamai could not load this row.");
}

function formatCell(value: string | number | null | undefined, column: TableColumn): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  const digits = column.type === "count" ? 0 : 2;
  const number = value.toLocaleString(undefined, { maximumFractionDigits: digits });
  // Kamai's wall-surface table already names the unit in the header ("Height (m)"), so a
  // cell repeating it would read "2.7 m" under "(m)". A header without it gets it per cell.
  if (!column.unit || column.label.includes(`(${column.unit})`)) return number;
  return `${number} ${column.unit}`;
}

/** What the plan's banner calls the row: its first few text cells ("Doors · single swing
 * door · D1"), or the table's title when it has none. */
function rowLabel(data: TableData, row: TableRow): string {
  const words = data.columns
    .map((column) => row.cells[column.key])
    .filter((value): value is string => typeof value === "string" && value !== "")
    .slice(0, 3);
  return words.length ? words.join(" · ") : data.title;
}

export function TableWidget() {
  const data = useWidgetData<TableData>();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);

  if (!data) return <LoadingState label="Loading table…" />;
  if (!Array.isArray(data.columns) || !Array.isArray(data.rows)) {
    return <Card className="p-5 text-sm text-base-content/60">This table could not be read.</Card>;
  }

  const blueprintName = (id: string) => data.blueprints?.find((b) => b.blueprint_id === id)?.name || "Blueprint";

  const openPlan = async (row: TableRow, at: number, elements?: RowElements, blueprintId?: string) => {
    setBusy(at);
    setError(null);
    try {
      const resolved = elements ?? (await rowElements(callKamai, data, row));
      if (resolved.problem && !idCount(resolved.element_ids)) throw new Error(`This row ${resolved.problem}.`);
      const target = blueprintId ?? Object.entries(resolved.element_ids).find(([, ids]) => ids.length)?.[0];
      if (!target) throw new Error("This row has no elements to show.");
      const ids = resolved.element_ids[target] ?? [];
      const [blueprint, outlines] = await Promise.all([
        callKamai<BlueprintData>(
          "view_blueprint",
          { blueprint_id: target, project_id: data.project_id },
          (value) => typeof value?.blueprint_id === "string",
        ),
        highlightFor(callKamai, data.project_id, target, ids),
      ]);
      setPlan({
        row,
        label: rowLabel(data, row),
        elements: resolved,
        blueprintId: target,
        blueprint,
        highlight: { ids: new Set(ids), outlines: outlines.features, grid: outlines.grid || blueprint.grid || 0 },
        missing: new Set(outlines.missing).size,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error("Could not open the plan for this row."));
    } finally {
      setBusy(null);
    }
  };

  if (plan) {
    const shown = idCount(plan.elements.element_ids);
    const blueprints = Object.entries(plan.elements.element_ids).filter(([, ids]) => ids.length);
    const banner = (
      <Card className="mb-3 flex flex-wrap items-center gap-3 p-3 text-sm">
        <span className="font-medium">{plan.label}</span>
        <span className="text-base-content/60">
          {plan.elements.element_count} element{plan.elements.element_count === 1 ? "" : "s"}
        </span>
        {blueprints.length > 1 && (
          <select
            className="select select-bordered select-xs"
            value={plan.blueprintId}
            onChange={(event) => void openPlan(plan.row, -1, plan.elements, event.target.value)}
          >
            {blueprints.map(([id, ids]) => (
              <option key={id} value={id}>
                {blueprintName(id)} ({ids.length})
              </option>
            ))}
          </select>
        )}
        {plan.elements.element_ids_truncated && (
          <span className="text-xs text-warning">
            showing {shown} of {plan.elements.element_count}
          </span>
        )}
        {plan.missing > 0 && (
          <span className="text-xs text-warning">
            {plan.missing} no longer on this blueprint
          </span>
        )}
        {busy !== null && <LoaderCircle className="h-4 w-4 animate-spin text-primary" />}
      </Card>
    );
    return (
      <BlueprintPanel
        key={plan.blueprintId}
        initialData={plan.blueprint}
        highlight={plan.highlight}
        banner={banner}
        onBack={() => setPlan(null)}
      />
    );
  }

  const canHighlight = hostCanCallTools();
  const rtl = RTL.has((data.language ?? "").slice(0, 2));
  const subtitle = [data.project_name ? `in ${data.project_name}` : "", `${data.rows.length} rows`].filter(Boolean).join(" · ");

  return (
    <div dir={rtl ? "rtl" : "ltr"}>
      <BrandHeader title={data.title} subtitle={subtitle} />
      <ActionError error={error} className="mb-3" />
      {data.problems && data.problems.length > 0 && (
        <div className="alert alert-warning mb-3 py-2 text-sm">
          <AlertTriangle className="h-4 w-4" />
          <ul>
            {data.problems.map((problem) => (
              <li key={`${problem.row}-${problem.reason}`}>
                <bdi>Row {problem.row + 1}: {problem.reason}</bdi>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Card className="overflow-x-auto">
        <table className="table table-sm w-full tabular-nums">
          <thead className="sticky top-0 z-10 bg-base-200 text-base-content/60">
            <tr>
              {canHighlight && <th className="w-8" />}
              {data.columns.map((column) => (
                <th key={column.key} className={column.align === "right" || isNumeric(column) ? "text-end" : "text-start"}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, at) => {
              const kind = row.kind ?? "item";
              if (kind === "note") {
                return (
                  <tr key={at} className="text-xs italic text-base-content/60">
                    <td colSpan={data.columns.length + (canHighlight ? 1 : 0)}>
                      <bdi>{data.columns.map((column) => row.cells[column.key]).filter((v) => v !== null && v !== undefined && v !== "").join(" · ")}</bdi>
                    </td>
                  </tr>
                );
              }
              const lit = canHighlight && row.element_count > 0;
              return (
                <tr key={at} className={`hover:bg-base-200/60 ${kind === "total" ? "font-semibold" : ""}`}>
                  {canHighlight && (
                    <td>
                      {lit && (
                        <button
                          className="btn btn-ghost btn-xs btn-circle"
                          aria-label="Show on the plan"
                          title="Show on the plan"
                          disabled={busy !== null}
                          onClick={() => void openPlan(row, at)}
                        >
                          {busy === at ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
                        </button>
                      )}
                    </td>
                  )}
                  {data.columns.map((column) => (
                    <td key={column.key} className={column.align === "right" || isNumeric(column) ? "text-end" : "text-start"}>
                      {/* Isolated, so "1.40 m" stays "1.40 m" inside a Hebrew table. */}
                      <bdi>{formatCell(row.cells[column.key], column)}</bdi>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      {data.notes && data.notes.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-base-content/60">
          {data.notes.map((note) => (
            <li key={note}>
              <bdi>{note}</bdi>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function isNumeric(column: TableColumn): boolean {
  return column.type === "number" || column.type === "count" || column.type === "area" || column.type === "length";
}
