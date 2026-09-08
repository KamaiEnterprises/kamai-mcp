import { useState } from "react";
import { Map } from "lucide-react";

import { callTool } from "./bridge";
import { BlueprintPanel } from "./BlueprintWidget";
import { BrandHeader, Button, LoadingState } from "./shared";
import { TakeoffPanel } from "./TakeoffPanel";
import type { BlueprintData, TakeoffData } from "./types";
import { useWidgetData } from "./useWidgetData";

export function TakeoffWidget() {
  const data = useWidgetData<TakeoffData>();
  const [blueprint, setBlueprint] = useState<BlueprintData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!data) return <LoadingState label="Loading takeoff…" />;
  if (blueprint) return <BlueprintPanel initialData={blueprint} onBack={() => setBlueprint(null)} />;

  const openPlan = async () => {
    setLoading(true);
    setError(null);
    try {
      setBlueprint(await callTool<BlueprintData>("view_blueprint", {
        blueprint_id: data.blueprint_id,
        project_id: data.project_id || undefined,
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open this blueprint.");
    } finally {
      setLoading(false);
    }
  };

  const subtitle = [
    data.project_name ? `in ${data.project_name}` : "",
    data.rows ? `${data.rows.length} classes` : "",
    data.shapes ? `${data.shapes} shapes` : "",
    data.scale_label || "",
  ].filter(Boolean).join(" · ");

  return (
    <>
      <BrandHeader
        title={data.name || "Takeoff"}
        subtitle={subtitle}
        actions={<Button variant="outline" size="xs" icon={Map} loading={loading} onClick={openPlan}>View plan</Button>}
      />
      {error && <div className="alert alert-error mb-3 py-2 text-sm">{error}</div>}
      <TakeoffPanel data={data} />
    </>
  );
}
