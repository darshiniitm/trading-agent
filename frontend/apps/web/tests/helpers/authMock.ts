// For route tests whose db() is a bare marker object: replace the auth + ownership layer wholesale.
export const authMockModule = () => {
  const user = { userId: 1, role: "owner" as const, email: "owner@example.com", displayName: "Owner" };
  return {
    requireUser: async () => user, requireOwner: async () => user,
    withUser: async (_raw: unknown, _req: unknown, fn: (u: typeof user) => unknown) => fn(user),
    authErrorResponse: () => null, setIdentityResolver: () => {},
  };
};
export const ownershipMockModule = () => ({
  ownsDraft: () => true, ownsPrompt: () => true, canReadWatchlist: () => true, ownsWatchlist: () => true,
});
