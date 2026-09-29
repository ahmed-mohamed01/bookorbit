/**
 * Whether a link that names no read-along lost the one its pair generated. A link the build was never
 * attached to is a relink that lost it. The link it was attached to and that names no read-along was
 * detached on purpose, from the read-along's own page, and stays so.
 */
export function isLostReadAlongMember(link: { id: number; readAlongBookId: number | null }, attachedLinkId: number | null): boolean {
  // Another read-along already on the link is the user's choice, not a gap to fill.
  if (link.readAlongBookId !== null) return false;
  return link.id !== attachedLinkId;
}
