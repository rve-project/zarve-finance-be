import { createApp } from "./app";
import { env } from "./config/env";
import { startScheduler } from "./scheduler";
import { markOrphanedSyncsAsInterrupted } from "./utils/zarveMirrorSync";

const app = createApp();

app.listen(env.port, () => {
  console.log(`RVE Finance API running on http://localhost:${env.port}`);
  startScheduler();
  markOrphanedSyncsAsInterrupted().catch((err) => console.error("[sync] Gagal membersihkan status sync lama:", err));
});
