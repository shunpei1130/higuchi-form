import "server-only";

import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { invitations, members, organizations, users } from "./schema";
import { OPERATOR_EMAIL } from "./operatorBootstrapPolicy";

/**
 * Who may create an account and an organization on this instance.
 *
 * AUTH_SIGNUP=invite-only (default): the very first account can always be
 * created (it is the operator setting the instance up); after that an
 * account can only be created for an email address with a pending
 * invitation, and only the first organization's owners and admins (or the
 * first user, before any organization exists) can create organizations.
 *
 * AUTH_SIGNUP=open: anyone who can reach the instance can sign up and create
 * organizations — the model for a public, multi-customer deployment. It has
 * to be asked for: an instance is closed unless its operator opens it.
 *
 * Invitations work in both modes.
 */
export type SignupMode = "open" | "invite-only";

export function signupMode(): SignupMode {
  return process.env.AUTH_SIGNUP?.trim().toLowerCase() === "open" ? "open" : "invite-only";
}

/**
 * Whether anyone may sign up without an invitation right now: the instance
 * is open, or it has no account yet. Decides whether "Create one" is offered.
 */
export async function publicSignupAvailable(): Promise<boolean> {
  if(!(await productionBootstrapReady()))return false;
  if (signupMode() === "open") return true;
  const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
  return !anyUser;
}

/** Whether an account may be created for `email` right now. */
export async function mayCreateAccount(email: string): Promise<boolean> {
  if(!(await productionBootstrapReady()))return false;
  if (signupMode() === "open") return true;
  const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
  if (!anyUser) return true;
  const [invited] = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        sql`lower(${invitations.email}) = ${email.toLowerCase()}`,
        eq(invitations.status, "pending"),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return Boolean(invited);
}

/** Whether `userId` may create a new organization. */
export async function mayCreateOrganization(userId: string): Promise<boolean> {
  if(!(await productionBootstrapReady()))return false;
  if (signupMode() === "open") return true;
  const [first] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .orderBy(organizations.createdAt)
    .limit(1);
  if (!first) return true;
  const [membership] = await db
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.organizationId, first.id), eq(members.userId, userId)))
    .limit(1);
  return Boolean(membership && /\b(owner|admin)\b/.test(membership.role));
}

/** Public signup cannot win the empty-instance operator race in production. */
export async function productionBootstrapReady():Promise<boolean>{
  if(process.env.NODE_ENV!=="production"&&process.env.VERCEL!=="1")return true;
  const [operator]=await db.select({id:users.id}).from(users).innerJoin(members,eq(members.userId,users.id)).innerJoin(organizations,eq(organizations.id,members.organizationId)).where(and(sql`lower(${users.email})=${OPERATOR_EMAIL}`,sql`${organizations.metadata}::jsonb ->> 'initial' = 'true'`,sql`${organizations.metadata}::jsonb ->> 'bootstrapOperatorEmail' = ${OPERATOR_EMAIL}`,sql`${members.role} ~ '(^|,)owner(,|$)'`)).limit(1);
  return Boolean(operator);
}

/** OTP proves email ownership first; a personal tenant is then created once under a per-user lock. */
export async function ensureUserOrganization(userId:string):Promise<string|null>{
  if(!(await productionBootstrapReady()))return null;
  return db.transaction(async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'higuchi-user-org:'+userId},0))`);
    const [member]=await tx.select({organizationId:members.organizationId}).from(members).where(eq(members.userId,userId)).limit(1);
    if(member)return member.organizationId;
    const [user]=await tx.select({name:users.name,emailVerified:users.emailVerified}).from(users).where(eq(users.id,userId)).limit(1);
    if(!user?.emailVerified||signupMode()!=="open")return null;
    const [organization]=await tx.insert(organizations).values({name:`${user.name?.trim()||"新しいユーザー"}のワークスペース`.slice(0,120),slug:`workspace-${userId}`,metadata:JSON.stringify({higuchi:true})}).returning({id:organizations.id});
    await tx.insert(members).values({organizationId:organization.id,userId,role:"owner"});
    return organization.id;
  });
}
