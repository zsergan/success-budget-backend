import { AuthorSource } from './enums';

// The author fields of a record created by an authenticated user.
export const recordedAuthor = (userId: number) => ({
  author_user_id: userId,
  author_source: AuthorSource.RECORDED,
});
