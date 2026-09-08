import { useState } from "react";
import { ChevronDown, ChevronRight, FileText, FolderOpen, LoaderCircle } from "lucide-react";

import { callTool, updateModelContext } from "./bridge";
import { asArray, blueprintName, isBlueprintReady, relativeTime } from "./format";
import { BlueprintPanel } from "./BlueprintWidget";
import { BrandHeader, Card, EmptyState, LoadingState, PlanCardArtwork, StatusBadge } from "./shared";
import type { BlueprintData, BlueprintSummary, ProjectsData, ProjectSummary } from "./types";
import { useWidgetData } from "./useWidgetData";

function ProjectCard({
  project,
  expanded,
  loadingBlueprint,
  onToggle,
  onOpenBlueprint,
}: {
  project: ProjectSummary;
  expanded: boolean;
  loadingBlueprint: string | null;
  onToggle: () => void;
  onOpenBlueprint: (blueprint: BlueprintSummary) => void;
}) {
  const blueprints = asArray(project.blueprints);
  const count = project.blueprint_count ?? blueprints.length;
  const edited = relativeTime(project.last_modified);

  return (
    <Card className="w-full self-start transition hover:-translate-y-0.5 hover:shadow-lg">
      <button className="block w-full text-left" onClick={onToggle} aria-expanded={expanded}>
        <PlanCardArtwork count={count} />
        <div className="p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-medium">{project.name || "Untitled project"}</h2>
              {project.description && <p className="mt-0.5 line-clamp-2 text-xs text-base-content/55">{project.description}</p>}
            </div>
            {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-base-content/45" /> : <ChevronRight className="h-4 w-4 shrink-0 text-base-content/45" />}
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-base-content/45">
            <span>{count === 1 ? "1 blueprint" : `${count} blueprints`}</span>
            {edited && <span>Edited {edited}</span>}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-base-300 p-2">
          {blueprints.length ? blueprints.map((blueprint) => {
            const ready = isBlueprintReady(blueprint);
            const loading = loadingBlueprint === blueprint.id;
            return (
              <button
                key={blueprint.id}
                disabled={!ready || loading}
                onClick={() => onOpenBlueprint(blueprint)}
                className="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left transition hover:bg-base-200 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {loading ? <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-primary" /> : <FileText className="h-4 w-4 shrink-0 text-primary" />}
                  <span className="truncate text-xs font-medium">{blueprintName(blueprint)}</span>
                </span>
                <StatusBadge ready={ready} />
              </button>
            );
          }) : (
            <div className="px-3 py-5 text-center text-xs text-base-content/45">No blueprints in this project yet.</div>
          )}
        </div>
      )}
    </Card>
  );
}

// `data` is normally delivered by the host through the bridge. It can also be passed
// in directly, which is how the embedded panel falls back to the native experience on
// a host that refuses to frame the app: it fetches view_projects itself and renders
// this, rather than showing the user a dead end.
export function ProjectsWidget({ data: provided }: { data?: ProjectsData | ProjectSummary[] } = {}) {
  const delivered = useWidgetData<ProjectsData | ProjectSummary[]>();
  const data = provided ?? delivered;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<BlueprintData | null>(null);
  const [loadingBlueprint, setLoadingBlueprint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!data) return <LoadingState label="Loading projects…" />;
  if (selected) return <BlueprintPanel initialData={selected} onBack={() => setSelected(null)} />;

  const projects = Array.isArray(data) ? data : data.projects ?? [];

  const toggle = (projectId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const openBlueprint = async (project: ProjectSummary, blueprint: BlueprintSummary) => {
    setLoadingBlueprint(blueprint.id);
    setError(null);
    try {
      const result = await callTool<BlueprintData>("view_blueprint", {
        blueprint_id: blueprint.id,
        project_id: project.id,
      });
      setSelected(result);
      void updateModelContext(
        `Selected blueprint: ${blueprintName(blueprint)}\nProject: ${project.name}\nBlueprint id: ${blueprint.id}\nProject id: ${project.id}`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open this blueprint.");
    } finally {
      setLoadingBlueprint(null);
    }
  };

  return (
    <>
      <BrandHeader
        title="Projects"
        subtitle={projects.length === 1 ? "1 Kamai project" : `${projects.length} Kamai projects`}
      />
      {error && <div className="alert alert-error mb-3 py-2 text-sm">{error}</div>}
      {projects.length ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] items-start gap-4">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              expanded={expanded.has(project.id)}
              loadingBlueprint={loadingBlueprint}
              onToggle={() => toggle(project.id)}
              onOpenBlueprint={(blueprint) => openBlueprint(project, blueprint)}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={FolderOpen}
          title="No projects yet"
          description="Upload a blueprint to create your first Kamai project."
        />
      )}
    </>
  );
}
