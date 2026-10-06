import type { TraceEntry } from "../types";

interface Props {
  trace: TraceEntry[];
}

function summarizeResult(result: any): { label: string; tone: "ok" | "blocked" | "skipped" | "fail" | "neutral" } {
  if (result == null) return { label: "no result", tone: "neutral" };
  if (result.blocked) return { label: `blocked: ${result.blocked}`, tone: "blocked" };
  if (result.skipped) return { label: `skipped: ${result.skipped}`, tone: "skipped" };
  if (result.success === false) return { label: `failed: ${result.error ?? "unknown error"}`, tone: "fail" };
  if (result.success === true) return { label: "success", tone: "ok" };
  if (result.status === "waiting_for_user") return { label: "waiting for user...", tone: "neutral" };
  if (result.confirmed === true) return { label: "confirmed", tone: "ok" };
  if (result.confirmed === false) return { label: "not confirmed", tone: "fail" };
  return { label: "ok", tone: "ok" };
}

const TONE_COLORS: Record<string, string> = {
  ok: "#1a7f37",
  blocked: "#9a6700",
  skipped: "#6e7781",
  fail: "#cf222e",
  neutral: "#57606a"
};

export function TraceView({ trace }: Props) {
  if (trace.length === 0) {
    return <p className="trace-empty">No tool calls yet. Submit a request above to see the agent's trace here.</p>;
  }

  return (
    <ol className="trace-list">
      {trace.map((entry, i) => {
        const summary = summarizeResult(entry.result);
        return (
          <li key={i} className="trace-entry">
            <div className="trace-entry-header">
              <span className="trace-step">{i + 1}</span>
              <span className="trace-tool">{entry.tool}</span>
              <span className="trace-badge" style={{ color: TONE_COLORS[summary.tone] }}>
                {summary.label}
              </span>
              <span className="trace-time">{new Date(entry.timestamp).toLocaleTimeString()}</span>
            </div>
            <div className="trace-entry-body">
              <div>
                <strong>args</strong>
                <pre>{JSON.stringify(entry.args, null, 2)}</pre>
              </div>
              <div>
                <strong>result</strong>
                <pre>{JSON.stringify(entry.result, null, 2)}</pre>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
