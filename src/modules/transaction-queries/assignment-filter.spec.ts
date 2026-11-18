import { AssignmentKind } from '@shared/enums';
import { assignmentKey, memberKey, parseAssignmentFilter } from './assignment-filter';

describe('assignment filter', () => {
  it.each([
    ['space', { kind: AssignmentKind.SPACE }],
    ['unassigned', { kind: AssignmentKind.UNASSIGNED }],
    ['deleted_member', { kind: 'deleted_member' }],
    ['member:31', { kind: AssignmentKind.MEMBER, userId: 31 }],
    ['member:2147483647', { kind: AssignmentKind.MEMBER, userId: 2147483647 }],
  ])('reads %p', (value, filter) => {
    expect(parseAssignmentFilter(value)).toEqual(filter);
    expect(assignmentKey(filter as never)).toBe(value);
  });

  it.each(['', 'member', 'member:', 'member:0', 'member:01', 'member:2147483648', 'member:1.5', 'Space', 'others'])(
    'refuses %p',
    (value) => {
      expect(parseAssignmentFilter(value)).toBeNull();
    },
  );

  it('keys a member by the user id', () => {
    expect(memberKey(7)).toBe('member:7');
  });
});
