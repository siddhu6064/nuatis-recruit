/**
 * Inngest serve endpoint — registers all durable functions with the Inngest
 * platform (or local Inngest dev server in development).
 *
 * Mounted at /api/inngest by routes/index.ts.
 * The Inngest dev server (or cloud) polls this endpoint to discover functions
 * and dispatch events.
 */
import { serve } from "inngest/express";
import { inngest, functions } from "../lib/inngest";

export const inngestHandler = serve({ client: inngest, functions });
