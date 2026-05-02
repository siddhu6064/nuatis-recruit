import { Router, type IRouter, type Request, type Response } from "express";
import { db, usersTable, invitesTable } from "@workspace/db";
import { eq, and, isNull, gt } from "drizzle-orm";
import { requireAuth, getInviteToken, acceptInvite } from "@workspace/auth";

const router: IRouter = Router();

router.get("/workspace", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;

  const { workspacesTable } = await import("@workspace/db");
  const [workspace] = await db
    .select()
    .from(workspacesTable)
    .where(eq(workspacesTable.id, user.workspaceId));

  if (!workspace) {
    res.status(404).json({ error: "Workspace not found" });
    return;
  }

  res.json({
    id: workspace.id,
    name: workspace.name,
    organizationId: workspace.organizationId,
  });
});

router.get("/workspace/members", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;

  const members = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      role: usersTable.role,
      lastActiveAt: usersTable.lastActiveAt,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(eq(usersTable.workspaceId, user.workspaceId));

  res.json({
    members: members.map((m) => ({
      id: m.id,
      email: m.email,
      name: m.name ?? null,
      role: m.role ?? "recruiter",
      lastActiveAt: m.lastActiveAt?.toISOString() ?? null,
      createdAt: m.createdAt?.toISOString() ?? new Date().toISOString(),
    })),
  });
});

router.patch(
  "/workspace/members/:userId/role",
  async (req: Request, res: Response) => {
    const user = requireAuth(req, res);
    if (!user) return;

    if (user.role !== "owner") {
      res.status(403).json({ error: "Only owners can change roles" });
      return;
    }

    const { userId } = req.params as { userId: string };
    const { role } = req.body as { role: string };

    const allowed = ["owner", "recruiter", "readonly"];
    if (!allowed.includes(role)) {
      res.status(400).json({ error: "Invalid role" });
      return;
    }

    const [updated] = await db
      .update(usersTable)
      .set({ role })
      .where(
        and(
          eq(usersTable.id, userId),
          eq(usersTable.workspaceId, user.workspaceId),
        ),
      )
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    res.json({
      id: updated.id,
      email: updated.email,
      name: updated.name ?? null,
      role: updated.role ?? "recruiter",
      lastActiveAt: updated.lastActiveAt?.toISOString() ?? null,
      createdAt: updated.createdAt?.toISOString() ?? new Date().toISOString(),
    });
  },
);

router.delete(
  "/workspace/members/:userId",
  async (req: Request, res: Response) => {
    const user = requireAuth(req, res);
    if (!user) return;

    if (user.role !== "owner") {
      res.status(403).json({ error: "Only owners can remove members" });
      return;
    }

    const { userId } = req.params as { userId: string };

    if (userId === user.id) {
      res.status(400).json({ error: "Cannot remove yourself" });
      return;
    }

    await db
      .delete(usersTable)
      .where(
        and(
          eq(usersTable.id, userId),
          eq(usersTable.workspaceId, user.workspaceId),
        ),
      );

    res.json({ success: true });
  },
);

router.post("/workspace/invites", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;

  if (user.role !== "owner") {
    res.status(403).json({ error: "Only owners can create invites" });
    return;
  }

  const { email } = req.body as { email: string };
  if (!email || typeof email !== "string") {
    res.status(400).json({ error: "email is required" });
    return;
  }

  const token = await getInviteToken(user.workspaceId, email);

  const proto = req.headers["x-forwarded-proto"] || "https";
  const host =
    req.headers["x-forwarded-host"] || req.headers["host"] || "localhost";
  const origin = `${proto}://${host}`;
  const inviteUrl = `${origin}/accept-invite?token=${token}`;

  res.json({ token, inviteUrl });
});

router.get("/workspace/invites", async (req: Request, res: Response) => {
  const user = requireAuth(req, res);
  if (!user) return;

  if (user.role !== "owner") {
    res.status(403).json({ error: "Only owners can view invites" });
    return;
  }

  const now = new Date();
  const invites = await db
    .select()
    .from(invitesTable)
    .where(
      and(
        eq(invitesTable.workspaceId, user.workspaceId),
        isNull(invitesTable.usedAt),
        gt(invitesTable.expiresAt, now),
      ),
    );

  res.json({
    invites: invites.map((inv) => ({
      id: inv.id,
      email: inv.email,
      expiresAt: inv.expiresAt.toISOString(),
      usedAt: inv.usedAt?.toISOString() ?? null,
      createdAt: inv.createdAt?.toISOString() ?? new Date().toISOString(),
    })),
  });
});

router.post(
  "/workspace/invites/accept",
  async (req: Request, res: Response) => {
    const user = requireAuth(req, res);
    if (!user) return;

    const { token } = req.body as { token: string };
    if (!token) {
      res.status(400).json({ error: "token is required" });
      return;
    }

    const result = await acceptInvite(
      token,
      user.id,
      user.email ?? "",
      null,
    );

    if (!result) {
      res.status(400).json({ error: "Invalid or expired invite token" });
      return;
    }

    const [updatedUser] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, user.id));

    if (!updatedUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({
      id: updatedUser.id,
      email: updatedUser.email,
      name: updatedUser.name ?? null,
      role: updatedUser.role ?? "recruiter",
      lastActiveAt: updatedUser.lastActiveAt?.toISOString() ?? null,
      createdAt:
        updatedUser.createdAt?.toISOString() ?? new Date().toISOString(),
    });
  },
);

export default router;
