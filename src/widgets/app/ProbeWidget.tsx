import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleDashed, LoaderCircle, Minus, RotateCw, X } from "lucide-react";

import { reportSize } from "./bridge";
import { sendSummary, verdicts, type ProbeReport, type StepStatus, type WebgpuMode } from "./probe-report";
import { earlierRun, runProbe } from "./probe-run";
import { BrandHeader, Button, Card } from "./shared";
import { useWidgetData } from "./useWidgetData";

interface ProbeData {
  widget_version?: string;
  webgpu?: WebgpuMode;
}

// Some hosts deliver the tool result late or never (silent hosts). The probe does not
// need it to start: the WebGPU mode is read again just before WebGPU runs.
const DATA_GRACE_MS = 3000;

function StatusIcon({ status }: { status: StepStatus }) {
  if (status === "ok") return <Check className="h-4 w-4 text-success" />;
  if (status === "failed" || status === "timeout") return <X className="h-4 w-4 text-error" />;
  if (status === "pending") return <LoaderCircle className="h-4 w-4 animate-spin text-primary" />;
  if (status === "skipped") return <Minus className="h-4 w-4 text-base-content/50" />;
  return <CircleDashed className="h-4 w-4 text-base-content/50" />;
}

export function ProbeWidget() {
  const data = useWidgetData<ProbeData>();
  const dataRef = useRef<ProbeData | null>(null);
  dataRef.current = data;
  const [report, setReport] = useState<Partial<ProbeReport>>({});
  const [graceOver, setGraceOver] = useState(false);
  const [running, setRunning] = useState(false);
  const [previousRun, setPreviousRun] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setGraceOver(true), DATA_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const start = useCallback(() => {
    setRunning(true);
    setPreviousRun(null);
    void runProbe(dataRef.current?.widget_version, {
      onUpdate: setReport,
      webgpuMode: () => dataRef.current?.webgpu,
    }).finally(() => setRunning(false));
  }, []);

  useEffect(() => {
    if (started.current || (!data && !graceOver)) return;
    started.current = true;
    // A reopened conversation remounts this widget for a tool call that already ran.
    const earlier = earlierRun();
    if (earlier) setPreviousRun(earlier);
    else start();
  }, [data, graceOver, start]);

  useEffect(() => {
    reportSize();
  }, [report, previousRun]);

  const host = (report.host ?? {}) as { guess?: { family: string; surface: string }; host_info?: { name?: string; version?: string } };
  const subtitle = host.guess
    ? `${host.guess.family} · ${host.guess.surface}${host.host_info?.name ? ` · ${host.host_info.name} ${host.host_info.version ?? ""}` : ""}`
    : previousRun
      ? "Already run for this message"
      : "Detecting host…";

  if (previousRun) {
    return (
      <>
        <BrandHeader title="Host capability probe" subtitle={subtitle} />
        <Card className="flex flex-col items-center gap-3 p-6 text-center text-sm">
          <p className="text-base-content/70">This probe already ran and reported (run {previousRun.slice(0, 8)}).</p>
          <Button size="xs" icon={RotateCw} onClick={start}>
            Run again
          </Button>
        </Card>
      </>
    );
  }

  return (
    <>
      <BrandHeader
        title="Host capability probe"
        subtitle={subtitle}
        actions={
          report.phase === "final" && !running ? (
            <Button variant="ghost" size="xs" icon={RotateCw} onClick={start}>
              Run again
            </Button>
          ) : undefined
        }
      />
      <Card className="p-4">
        <ul className="flex flex-col gap-2 text-sm">
          {verdicts(report).map((row) => (
            <li key={row.label} className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0">
                <StatusIcon status={row.status} />
              </span>
              <span className="min-w-0">
                <span className="font-medium">{row.label}</span>
                {row.detail && <span className="block break-words text-xs text-base-content/60">{row.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-base-content/60">{sendSummary(report)}</p>
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-base-content/60">Raw report</summary>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-base-200 p-2">
            {JSON.stringify(report, null, 2)}
          </pre>
        </details>
      </Card>
    </>
  );
}
