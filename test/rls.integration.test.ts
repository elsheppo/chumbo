import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

const url = process.env.SUPABASE_INTEGRATION_URL;
const publishableKey = process.env.SUPABASE_INTEGRATION_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_INTEGRATION_SECRET_KEY;
const enabled = Boolean(url && publishableKey && secretKey);

async function retryLocalAuth<Value>(
  operation: () => Promise<Value>,
): Promise<Value> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof Error) ||
        error.name !== "AuthRetryableFetchError" ||
        attempt === 3
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw lastError;
}

describe.skipIf(!enabled)("real Supabase RLS isolation", () => {
  it("separates concurrent organization slices for two users", async () => {
    const admin = createClient(url!, secretKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const password = `Csm-${crypto.randomUUID()}!`;
    const userIds: string[] = [];
    const organizationIds: string[] = [];

    try {
      const users = [];
      for (const name of ["alice", "bob"]) {
        const email = `csm-${name}-${suffix}@example.com`;
        const data = await retryLocalAuth(async () => {
          const result = await admin.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
          });
          if (result.error) throw result.error;
          return result.data;
        });
        userIds.push(data.user.id);
        users.push({ email, id: data.user.id, name });
      }

      const { data: organizations, error: organizationError } = await admin
        .from("csm_organizations")
        .insert(
          users.map((user) => ({
            name: `Organization ${user.name} ${suffix}`,
          })),
        )
        .select("id, name");
      if (organizationError) throw organizationError;
      organizationIds.push(
        ...organizations.map((organization) => organization.id),
      );

      const membershipRows = users.map((user, index) => ({
        user_id: user.id,
        organization_id: organizations[index]!.id,
      }));
      const { error: membershipError } = await admin
        .from("csm_memberships")
        .insert(membershipRows);
      if (membershipError) throw membershipError;

      const documentRows = users.map((user, index) => ({
        organization_id: organizations[index]!.id,
        title: `${user.name}-private-${suffix}`,
        body: `Only ${user.name} should see this.`,
      }));
      const { data: documents, error: documentError } = await admin
        .from("csm_documents")
        .insert(documentRows)
        .select("id, organization_id, title");
      if (documentError) throw documentError;

      const clients: SupabaseClient[] = [];
      for (const user of users) {
        const client = createClient(url!, publishableKey!, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        await retryLocalAuth(async () => {
          const result = await client.auth.signInWithPassword({
            email: user.email,
            password,
          });
          if (result.error) throw result.error;
        });
        clients.push(client);
      }

      const readAs = async (client: SupabaseClient) => {
        const { data, error } = await client
          .from("csm_documents")
          .select("id, organization_id, title")
          .order("title");
        if (error) throw error;
        return { client, rows: data };
      };

      const [alice, bob] = await Promise.all(clients.map(readAs));
      if (!alice || !bob) throw new Error("Expected Alice and Bob fixtures");
      expect(alice.rows).toEqual([documents[0]]);
      expect(bob.rows).toEqual([documents[1]]);

      const [aliceCrossTenant, bobCrossTenant] = await Promise.all([
        alice.client
          .from("csm_documents")
          .select("id")
          .eq("id", documents[1]!.id),
        bob.client
          .from("csm_documents")
          .select("id")
          .eq("id", documents[0]!.id),
      ]);
      expect(aliceCrossTenant.error).toBeNull();
      expect(aliceCrossTenant.data).toEqual([]);
      expect(bobCrossTenant.error).toBeNull();
      expect(bobCrossTenant.data).toEqual([]);
    } finally {
      if (organizationIds.length > 0) {
        await admin
          .from("csm_documents")
          .delete()
          .in("organization_id", organizationIds);
        await admin
          .from("csm_memberships")
          .delete()
          .in("organization_id", organizationIds);
        await admin
          .from("csm_organizations")
          .delete()
          .in("id", organizationIds);
      }
      for (const userId of userIds) {
        await retryLocalAuth(async () => {
          const result = await admin.auth.admin.deleteUser(userId);
          if (result.error) throw result.error;
        });
      }
    }
  }, 120_000);
});
