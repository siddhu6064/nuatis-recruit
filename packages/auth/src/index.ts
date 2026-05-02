// AUTH ABSTRACTION — swap implementation here to change providers (Replit Auth → Clerk). Pages/routes consume these exports only.
import { db, usersTable, invitesTable } from "@workspace/db";
import { eq, and, gt, isNull } from "drizzle-orm";
import crypto from "crypto";

export type AuthUserInfo = {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
  workspaceId: string;
  role: string;
};

declare global {
  namespace Express {
    interface User extends AuthUserInfo {}
    interface Request {
      isAuthenticated(): this is { user: User };
      user?: User | undefined;
    }
  }
}

export function getCurrentUser(req: Express.Request): AuthUserInfo | null {
  if (!req.isAuthenticated()) return null;
  return req.user as AuthUserInfo;
}

export function requireAuth(
  req: Express.Request,
  res: { status(code: number): { json(body: unknown): void }; json(body: unknown): void },
): AuthUserInfo | null {
  const user = getCurrentUser(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return user;
}

export async function getInviteToken(
  workspaceId: string,
  email: string,
): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await db.insert(invitesTable).values({
    workspaceId,
    email,
    token,
    expiresAt,
  });

  return token;
}

export async function acceptInvite(
  token: string,
  externalAuthId: string,
  email: string,
  name?: string | null,
): Promise<{ workspaceId: string; role: string } | null> {
  const now = new Date();

  const [invite] = await db
    .select()
    .from(invitesTable)
    .where(
      and(
        eq(invitesTable.token, token),
        gt(invitesTable.expiresAt, now),
        isNull(invitesTable.usedAt),
      ),
    );

  if (!invite) return null;

  const existingUsers = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.externalAuthId, externalAuthId));

  const existingInWorkspace = existingUsers.find(
    (u) => u.workspaceId === invite.workspaceId,
  );

  if (existingInWorkspace) {
    await db
      .update(invitesTable)
      .set({ usedAt: now })
      .where(eq(invitesTable.id, invite.id));
    return {
      workspaceId: invite.workspaceId,
      role: existingInWorkspace.role ?? "recruiter",
    };
  }

  const [newUser] = await db
    .insert(usersTable)
    .values({
      workspaceId: invite.workspaceId,
      externalAuthId,
      externalAuthProvider: "replit",
      email,
      name: name ?? null,
      role: "recruiter",
    })
    .onConflictDoUpdate({
      target: usersTable.externalAuthId,
      set: {
        workspaceId: invite.workspaceId,
        role: "recruiter",
      },
    })
    .returning();

  await db
    .update(invitesTable)
    .set({ usedAt: now })
    .where(eq(invitesTable.id, invite.id));

  return {
    workspaceId: invite.workspaceId,
    role: newUser.role ?? "recruiter",
  };
}
