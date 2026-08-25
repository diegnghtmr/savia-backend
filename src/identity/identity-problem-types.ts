// Identity's own problem-type vocabulary. These URIs describe identity domain
// rules -- onboarding conflicts, personal-workspace constraints, invitation
// lifecycle -- so they belong to identity, not to the transport layer.
//
// They previously sat in platform/problem-details.ts alongside the generic
// RFC 9457 registry. No import crossed a boundary (these are plain strings), so
// no dependency rule fired, which is exactly why the inversion could persist:
// platform's defining rule is that it must not know about features, and a
// constant named LAST_OWNER_REQUIRED is feature knowledge. Left there, every
// slice of Epica 2 would have appended its own domain URIs and turned the
// transport layer into the vocabulary junk drawer for the whole product.
const BASE_URI = 'https://savia.app/problems';

export const IDENTITY_PROBLEM_TYPES = {
  ONBOARDING_CONFLICT: `${BASE_URI}/onboarding-conflict`,
  PERSONAL_WORKSPACE_MEMBERSHIP: `${BASE_URI}/personal-workspace-membership`,
  LAST_OWNER_REQUIRED: `${BASE_URI}/last-owner-required`,
  PERSONAL_WORKSPACE_INVITATION: `${BASE_URI}/personal-workspace-invitation`,
  WORKSPACE_INVITATION_EXISTING_MEMBER: `${BASE_URI}/workspace-invitation-existing-member`,
  WORKSPACE_INVITATION_ALREADY_PENDING: `${BASE_URI}/workspace-invitation-already-pending`,
  WORKSPACE_INVITATION_NOT_PENDING: `${BASE_URI}/workspace-invitation-not-pending`,
} as const;
