import type { MetaHarnessConfig } from "../../types.js";
import { SqliteStorage } from "../../storage/sqlite.js";

export async function findingsCommand(
  config: Required<MetaHarnessConfig>,
  opts: { type?: string; severity?: string; unreported: boolean; limit: string },
): Promise<void> {
  const storage = new SqliteStorage(config.storage.path!);

  const findings = await storage.queryFindings({
    type: opts.type as any,
    severity: opts.severity as any,
    reported: opts.unreported ? false : undefined,
    limit: parseInt(opts.limit, 10),
  });

  if (findings.length === 0) {
    console.log("No findings found.");
    await storage.close();
    return;
  }

  console.log(`\nShowing ${findings.length} findings:\n`);

  for (const f of findings) {
    const time = new Date(f.analyzedAt).toISOString();
    const badge = f.severity === "critical" ? "🔴" : f.severity === "warning" ? "🟡" : "🔵";
    const reported = f.reported ? "✓" : "✗";
    console.log(
      `  ${badge} [${time}] ${f.type.padEnd(20)} ${f.title}`,
    );
    console.log(
      `     Confidence: ${(f.confidence * 100).toFixed(0)}% | Reported: ${reported}${f.reportRef ? ` (${f.reportRef})` : ""}`,
    );
  }

  await storage.close();
}
