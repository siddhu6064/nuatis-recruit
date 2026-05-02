import { Router, type IRouter, type Request, type Response } from "express";
import { db, clientsTable } from "@workspace/db";
import { eq, and, count } from "drizzle-orm";
import { requireAuth } from "@workspace/auth";
import { withAudit } from "@workspace/audit";
import { jobsTable } from "@workspace/db";

const router: IRouter = Router();

// POST /api/clients
router.post("/clients", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;

  const { name, primaryContactName, contactEmail, contactPhone, contractTerms } = req.body as Record<string, string>;
  if (!name?.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const [client] = await withAudit(
    txDb,
    {
      workspaceId: user.workspaceId,
      action: "client.create",
      targetType: "client",
      userId: user.id,
      ip: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    },
    () =>
      txDb
        .insert(clientsTable)
        .values({
          workspaceId: user.workspaceId,
          name: name.trim(),
          primaryContactName: primaryContactName ?? null,
          contactEmail: contactEmail ?? null,
          contactPhone: contactPhone ?? null,
          contractTerms: contractTerms ?? null,
        })
        .returning(),
  );

  res.status(201).json(client);
});

// GET /api/clients
router.get("/clients", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;

  const clients = await txDb
    .select({
      id: clientsTable.id,
      name: clientsTable.name,
      primaryContactName: clientsTable.primaryContactName,
      contactEmail: clientsTable.contactEmail,
      createdAt: clientsTable.createdAt,
    })
    .from(clientsTable)
    .where(eq(clientsTable.workspaceId, user.workspaceId));

  // Count open jobs per client
  const openJobCounts = await txDb
    .select({ clientId: jobsTable.clientId, count: count() })
    .from(jobsTable)
    .where(and(eq(jobsTable.workspaceId, user.workspaceId), eq(jobsTable.status, "open")))
    .groupBy(jobsTable.clientId);

  const countMap = new Map(openJobCounts.map((r) => [r.clientId, Number(r.count)]));

  res.json({
    clients: clients.map((c) => ({
      ...c,
      createdAt: c.createdAt?.toISOString() ?? null,
      openJobCount: countMap.get(c.id) ?? 0,
    })),
  });
});

// GET /api/clients/:id
router.get("/clients/:id", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;

  const [client] = await txDb
    .select()
    .from(clientsTable)
    .where(
      and(
        eq(clientsTable.id, req.params.id),
        eq(clientsTable.workspaceId, user.workspaceId),
      ),
    );

  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  res.json({ ...client, createdAt: client.createdAt?.toISOString() ?? null });
});

// PATCH /api/clients/:id
router.patch("/clients/:id", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;
  const txDb = req.db ?? db;

  const [existing] = await txDb
    .select()
    .from(clientsTable)
    .where(
      and(
        eq(clientsTable.id, req.params.id),
        eq(clientsTable.workspaceId, user.workspaceId),
      ),
    );

  if (!existing) {
    res.status(404).json({ error: "Client not found" });
    return;
  }

  const { name, primaryContactName, contactEmail, contactPhone, contractTerms } = req.body as Record<string, string>;
  const patch: Record<string, string | null> = {};
  if (name !== undefined) patch.name = name.trim() || existing.name;
  if (primaryContactName !== undefined) patch.primaryContactName = primaryContactName;
  if (contactEmail !== undefined) patch.contactEmail = contactEmail;
  if (contactPhone !== undefined) patch.contactPhone = contactPhone;
  if (contractTerms !== undefined) patch.contractTerms = contractTerms;

  const [updated] = await withAudit(
    txDb,
    {
      workspaceId: user.workspaceId,
      action: "client.update",
      targetType: "client",
      targetId: req.params.id,
      userId: user.id,
      ip: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    },
    () =>
      txDb
        .update(clientsTable)
        .set(patch)
        .where(eq(clientsTable.id, req.params.id))
        .returning(),
  );

  res.json({ ...updated, createdAt: updated.createdAt?.toISOString() ?? null });
});

export default router;
