/**
 * Sparkden / Velocity platform API client.
 *
 * Uses OAuth2 client-credentials flow with the secrets stored in
 * VELOCITY_CLIENT_ID and VELOCITY_CLIENT_SECRET.
 *
 * The token endpoint and resource base URL are environment-configurable so
 * the actual Sparkden tenant URL can be set without code changes.
 */

const BASE_URL =
  process.env["VELOCITY_API_BASE_URL"] ?? "https://api.sparkden.io/v1";
const TOKEN_URL =
  process.env["VELOCITY_TOKEN_URL"] ??
  "https://auth.sparkden.io/oauth2/token";

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export interface AthleteSession {
  session_id: string;
  date: string;
  exercise: string;
  mean_velocity_ms: number;
  peak_velocity_ms: number;
  load_kg: number;
  estimated_1rm_pct: number;
  reps: number;
}

// ---------------------------------------------------------------------------
// Token cache — reuse within the process lifetime
// ---------------------------------------------------------------------------
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt - 30_000) {
    return cachedToken;
  }

  const clientId = process.env["VELOCITY_CLIENT_ID"];
  const clientSecret = process.env["VELOCITY_CLIENT_SECRET"];

  if (!clientId || !clientSecret) {
    throw new Error("VELOCITY_CLIENT_ID or VELOCITY_CLIENT_SECRET not set");
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "read:sessions read:athletes",
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Sparkden token fetch failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as TokenResponse;
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

/** Fetch recent sessions for the given exercise (last 10 by default). */
export async function fetchAthleteSessions(
  exerciseName: string,
  limit = 10,
): Promise<AthleteSession[]> {
  const token = await getAccessToken();

  const url = new URL(`${BASE_URL}/sessions`);
  url.searchParams.set("exercise", exerciseName);
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Sparkden sessions fetch failed (${res.status})`);
  }

  const json = await res.json() as { data: AthleteSession[] };
  return json.data ?? [];
}

/** Returns true when both Sparkden secrets are present in the environment. */
export function isSparkdenConfigured(): boolean {
  return Boolean(
    process.env["VELOCITY_CLIENT_ID"] && process.env["VELOCITY_CLIENT_SECRET"],
  );
}
