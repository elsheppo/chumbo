import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

const url = process.env.SUPABASE_INTEGRATION_URL;
const publishableKey = process.env.SUPABASE_INTEGRATION_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_INTEGRATION_SECRET_KEY;
const enabled = Boolean(url && publishableKey && secretKey);

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
      const users = await Promise.all(
        ["alice", "bob"].map(async (name) => {
          const email = `csm-${name}-${suffix}@example.com`;
          const { data, error } = await admin.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
          });
          if (error) throw error;
          userIds.push(data.user.id);
          return { email, id: data.user.id, name };
        }),
      );

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

      const readAs = async (email: string) => {
        const client = createClient(url!, publishableKey!, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { error: signInError } = await client.auth.signInWithPassword({
          email,
          password,
        });
        if (signInError) throw signInError;
        const { data, error } = await client
          .from("csm_documents")
          .select("id, organization_id, title")
          .order("title");
        if (error) throw error;
        return { client, rows: data };
      };

      const [alice, bob] = await Promise.all(
        users.map((user) => readAs(user.email)),
      );
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
      await Promise.all(
        userIds.map((userId) => admin.auth.admin.deleteUser(userId)),
      );
    }
  });
});
