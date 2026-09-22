import { createApp } from "./app";
import { env } from "./config/env";
import { startScheduler } from "./scheduler";

const app = createApp();

app.listen(env.port, () => {
  console.log(`RVE Finance API running on http://localhost:${env.port}`);
  startScheduler();
});
