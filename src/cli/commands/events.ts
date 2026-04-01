import type { MetaHarnessConfig } from "../../types.js";
import { SqliteStorage } from "../../storage/sqlite.js";
import { parseWindow } from "../../config.js";

export async function eventsCommand(
  config: Required<MetaHarnessConfig>,
  opts: { feature?: string; type?: string; since: string; limit: string },
): Promise<void> {
  const storage = new SqliteStorage(config.storage.path!);
  const since = Date.now() - parseWindow(opts.since);

  const events = await storage.queryEvents({
    since,
    feature: opts.feature,
    type: opts.type as any,
    limit: parseInt(opts.limit, 10),
  });

  if (events.length === 0) {
    console.log("No events found.");
    await storage.close();
    return;
  }

  console.log(`\nShowing ${events.length} events:\n`);

  for (const event of events) {
    const time = new Date(event.timestamp).toISOString();
    console.log(
      `  [${time}] ${event.type.padEnd(15)} ${event.feature.padEnd(30)} ${event.action.padEnd(15)} actor:${event.actor}`,
    );
  }

  await storage.close();
}
