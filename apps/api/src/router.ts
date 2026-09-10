import { router } from "./trpc.ts";
import { authRouter } from "./routers/auth.ts";
import { campaignsRouter, masterDataRouter } from "./routers/campaigns.ts";
import { participantsRouter } from "./routers/participants.ts";
import { submissionsRouter, entriesRouter } from "./routers/submissions.ts";
import { drawsRouter, winnersRouter } from "./routers/draws.ts";
import { supportRouter, opsRouter, staffRouter, auditRouter, reportsRouter, readinessRouter, publicRouter, simulatorRouter } from "./routers/ops.ts";
export const appRouter = router({ auth: authRouter, campaigns: campaignsRouter, masterData: masterDataRouter, participants: participantsRouter, submissions: submissionsRouter, entries: entriesRouter, draws: drawsRouter, winners: winnersRouter, support: supportRouter, ops: opsRouter, staff: staffRouter, audit: auditRouter, reports: reportsRouter, readiness: readinessRouter, public: publicRouter, simulator: simulatorRouter });
export type AppRouter = typeof appRouter;
