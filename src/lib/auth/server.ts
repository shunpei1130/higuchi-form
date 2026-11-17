import "server-only";

import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { emailOTP, jwt, organization } from "better-auth/plugins";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { authEmail, sendAuthEmail } from "./email";
import { ac, roles } from "./permissions";
import { authSchema, members } from "./schema";
import { ensureUserOrganization, mayCreateAccount, mayCreateOrganization } from "./signup";
import { isolateMcpResourceSeeds } from "./mcpSimulation";
import { MCP_SCOPES } from "@/lib/publicApi/scopes";
import {
  ORGANIZATION_CLAIM,
  ORGANIZATION_PICKER_PAGE,
  connectionOrganizationId,
  mcpResourceUrl,
  needsOrganizationChoice,
} from "@/lib/mcp/oauth";

/**
 * The Better Auth instance: email + password (verified), Google when
 * configured, and organizations with teams. Mounted at /api/auth/[...all].
 *
 * It reuses the app's one Drizzle pool (src/lib/db.ts) — never give it a
 * connection of its own; the database server has 50 slots shared by every
 * deployment.
 *
 * Better Auth authenticates and tracks the active organization; it does not
 * scope our tables. That is src/lib/auth/context.ts and every query after it.
 */

const baseURL = process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL;

/** Identity scopes plus what an MCP client may do (src/lib/publicApi/scopes.ts). */
const OAUTH_SCOPES = ["openid", "profile", "email", "offline_access", ...MCP_SCOPES];

const googleConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const linkedinConfigured = Boolean(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET);

/** Keep the MCP plugin's inferred APIs while preventing its startup resource seed in local simulation. */
function mcpForCurrentMode(options:Parameters<typeof mcp>[0]) {
  return isolateMcpResourceSeeds(mcp(options),process.env.HIGUCHI_MODE,process.env.HIGUCHI_ENABLE_LEGACY_MCP==="true"&&process.env.NEXT_PHASE!=="phase-production-build");
}

/** The organization a fresh session opens in: the one the user joined first. */
async function initialOrganizationId(userId: string): Promise<string | null> {
  const [membership] = await db
    .select({ organizationId: members.organizationId })
    .from(members)
    .where(eq(members.userId, userId))
    .orderBy(asc(members.createdAt))
    .limit(1);
  return membership?.organizationId ?? ensureUserOrganization(userId);
}

export const auth = betterAuth({
  appName: "higuchi-form",
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: baseURL ? [baseURL] : [],
  database: drizzleAdapter(db, { provider: "pg", schema: authSchema, usePlural: true }),
  advanced: {
    database: { generateId: "uuid" },
  },

  // The JWT plugin's own session-to-JWT endpoint is not wanted: access
  // tokens come only from the OAuth flow below.
  disabledPaths: ["/token"],

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 8,
    revokeSessionsOnPasswordReset: true,
    // Await queue persistence only; provider delivery happens in a durable job.
    sendResetPassword: async ({ user, url }) => {
      await sendAuthEmail(
        authEmail({
          to: user.email,
          subject: "higuchi-form のパスワード再設定",
          intro: "パスワード再設定のリクエストを受け付けました。",
          action: "新しいパスワードを設定する",
          url,
        }),
      );
    },
  },

  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendAuthEmail(
        authEmail({
          to: user.email,
          subject: "higuchi-form のメールアドレス確認",
          intro: `${user.name}様、アカウントの登録を完了するため、メールアドレスをご確認ください。`,
          action: "メールアドレスを確認する",
          url,
        }),
      );
    },
  },

  socialProviders: {
      ...(googleConfigured ? { google: {
          clientId: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          prompt: "select_account",
        } } : {}),
      ...(linkedinConfigured ? { linkedin: { clientId: process.env.LINKEDIN_CLIENT_ID!, clientSecret: process.env.LINKEDIN_CLIENT_SECRET! } } : {}),
  },

  account: {
    // Signing in with Google as an address that already has a password
    // account joins the two, rather than failing or making a second user.
    accountLinking: { enabled: true, trustedProviders: ["google", "linkedin"] },
  },

  session: {
    // Most requests are answered from a signed cookie instead of a sessions
    // lookup — the connection pool is small. A revoked session or role change
    // can therefore take up to this long to bite.
    cookieCache: { enabled: true, maxAge: 2 * 60 },
  },

  databaseHooks: {
    user: {
      create: {
        // AUTH_SIGNUP=invite-only: no account without a pending invitation
        // (the instance's very first account excepted). Covers Google too.
        before: async (user) => {
          if (!(await mayCreateAccount(user.email))) {
            throw new APIError("FORBIDDEN", {
              message: "この環境への登録には招待が必要です。管理者にお問い合わせください。",
            });
          }
        },
      },
    },
    session: {
      create: {
        before: async (session) => ({
          data: {
            ...session,
            activeOrganizationId: session.activeOrganizationId ?? (await initialOrganizationId(session.userId)),
          },
        }),
      },
    },
  },

  plugins: [
    emailOTP({
      otpLength: 6, expiresIn: 300, allowedAttempts: 3, storeOTP: "hashed",
      async sendVerificationOTP({ email, otp }) {
        await sendAuthEmail({
          to: email, subject: "higuchi-form の認証コード",
          text: `認証コードは ${otp} です。5分以内に入力してください。心当たりがない場合は、このメールを無視してください。`,
          html: `<html lang="ja"><body style="font-family:sans-serif;color:#222"><h2>higuchi-form</h2><p>認証コードは <strong style="font-size:26px;letter-spacing:5px">${otp}</strong> です。</p><p>5分以内に入力してください。心当たりがない場合は、このメールを無視してください。</p></body></html>`,
        });
      },
    }),
    organization({
      ac,
      roles,
      teams: { enabled: true },
      allowUserToCreateOrganization: (user) => mayCreateOrganization(user.id),
      invitationExpiresIn: 7 * 24 * 60 * 60,
      cancelPendingInvitationsOnReInvite: true,
      sendInvitationEmail: async ({ id, email, organization, inviter }) => {
        await sendAuthEmail(
          authEmail({
            to: email,
            subject: `${organization.name}への招待 — higuchi-form`,
            intro: `${inviter.user.name}様から、${organization.name}への招待が届いています。`,
            action: "招待を受ける",
            url: `${baseURL}/accept-invitation/${id}`,
            outro: "この招待は7日間有効です。心当たりがない場合は、このメールを無視してください。",
          }),
        );
      },
    }),
    // OAuth 2.1 for MCP clients (Claude, Claude Desktop, Claude Code): /api/mcp
    // is the protected resource, this app the authorization server. Signing
    // keys live in `jwks`; tokens, clients and consents in the oauth_* tables.
    jwt({ disableSettingJwtHeader: true, schema: { jwks: { modelName: "jwk" } } }),
    mcpForCurrentMode({
      resource: mcpResourceUrl(),
      loginPage: "/sign-in",
      consentPage: "/oauth/consent",
      // crm:read / crm:write / crm:send — the person can grant fewer on the
      // consent screen; a client that registers without naming scopes may
      // ask for any of them.
      scopes: OAUTH_SCOPES,
      clientRegistrationDefaultScopes: OAUTH_SCOPES,
      // Claude Code registers itself (RFC 7591); claude.ai prefers a Client ID
      // Metadata Document (cimd below) and falls back to registration.
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      // Claude Code, Cursor and other desktop clients register a loopback
      // callback (http://localhost:<port>/callback) without saying they are
      // native apps; under the default ("web") that registration is refused.
      clientRegistrationDefaultApplicationType: "infer",
      postLogin: {
        page: ORGANIZATION_PICKER_PAGE,
        shouldRedirect: needsOrganizationChoice,
        consentReferenceId: connectionOrganizationId,
      },
      customAccessTokenClaims: ({ referenceId }) => (referenceId ? { [ORGANIZATION_CLAIM]: referenceId } : {}),
    }),
    cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
    // Must stay last: lets server actions set Better Auth's cookies.
    nextCookies(),
  ],
});

export type AuthSession = typeof auth.$Infer.Session;

/** Whether "Continue with Google" should be offered. */
export const GOOGLE_SIGN_IN_ENABLED = googleConfigured;
export const LINKEDIN_SIGN_IN_ENABLED = linkedinConfigured;
