import { Permission } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';

export function isEligibleMonitoredUser(user: RequestUser): boolean {
  return user.active && (user.isSuperuser || user.permissions.includes(Permission.BookRequestAccess));
}
