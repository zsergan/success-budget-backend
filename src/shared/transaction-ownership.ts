import { AssignmentKind, AuthorSource } from './enums';

// The author fields of a record created by an authenticated user.
export const recordedAuthor = (userId: number) => ({
  author_user_id: userId,
  author_source: AuthorSource.RECORDED,
});

// v1 writes cannot say whom a record is for, so they assign the whole space.
export const SPACE_ASSIGNMENT = {
  assignment_kind: AssignmentKind.SPACE,
  assigned_user_id: null,
} as const;
